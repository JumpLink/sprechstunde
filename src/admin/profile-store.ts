/**
 * Writing venue profiles from the settings UI. A profile is the one file a venue's greeting, facts
 * and transfer number live in, so a save has to be hard to get wrong and easy to take back:
 *
 * - only plain `*.json` files in the profiles directory are touched (`profileFilePath`);
 * - the file is validated by the very parser the agent's loader uses, so a save the UI accepts is a
 *   profile a call can start with — an empty greeting (the AI disclosure) included;
 * - fields the UI does not edit (voice, timeZone, locale, id, unknown future keys) are carried over
 *   from the file as it is, not rebuilt from a parsed copy;
 * - the write is a rename of a temp file, and the old version is copied to `.history/` first.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type Fact, parseProfile, type Profile } from '../core/profile.js';
import { profileFilePath, profilesDir } from '../core/settings.js';
import { maskTransferTarget } from '../core/tools.js';
import { _ } from '../i18n.js';
import { HttpError } from './http-error.js';

export const HISTORY_DIR = '.history';
/** Versions kept per profile; older ones are deleted on the next save. */
export const HISTORY_KEEP = 20;
const MAX_TEXT_CHARS = 20_000;
const MAX_FACTS = 200;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;

/** What the page edits. `transferTarget` is write-only: absent or empty keeps the one in the file. */
export interface ProfileDraft {
  assistantName: string;
  greeting: string;
  instructions: string;
  facts: Fact[];
  transfer: { announce: string } | null;
  transferTarget?: string;
  fallback: string | null;
}

/** The same fields as the page gets them: the target only as far as `maskTransferTarget` shows it. */
export interface DraftView {
  assistantName: string;
  greeting: string;
  instructions: string;
  facts: Fact[];
  transfer: { announce: string; targetMasked: string } | null;
  fallback: string | null;
}

export interface HistoryEntry {
  /** What `restore` takes. */
  version: string;
  /** ISO time the version was replaced. */
  at: string;
  size: number;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

export const revisionOf = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new HttpError(400, _('"%s" must be a string').replace('%s', name));
  if (value.length > MAX_TEXT_CHARS) throw new HttpError(400, _('"%s" is too long').replace('%s', name));
  return value;
}

/** Accepts `tel:+49…`, `sip:user@host` and a bare number, which becomes `tel:`. */
export function normalizeTarget(input: string): string {
  const value = input.trim();
  const bare = value.replace(new RegExp('[ ()./-]', 'g'), '');
  if (new RegExp('^\\+?[0-9]{3,20}$').test(bare)) return `tel:${bare}`;
  if (new RegExp('^tel:\\+?[0-9]{3,20}$').test(value)) return value;
  if (value.startsWith('sip:') && value.length > 6 && value.length <= 200) {
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (code <= 32 || code === 127) throw invalidTarget();
    }
    return value;
  }
  throw invalidTarget();
}

const invalidTarget = (): HttpError =>
  new HttpError(400, _('the transfer target must be a phone number, tel:+… or sip:user@host'));

export function parseDraft(raw: unknown): ProfileDraft {
  if (!isRecord(raw)) throw new HttpError(400, _('"draft" must be an object'));
  if (!Array.isArray(raw.facts) || raw.facts.length > MAX_FACTS) {
    throw new HttpError(400, _('"facts" must be a list of at most %s entries').replace('%s', String(MAX_FACTS)));
  }
  const facts = raw.facts.map((entry, index): Fact => {
    if (!isRecord(entry)) throw new HttpError(400, _('"facts" must be a list of topic and answer'));
    return { topic: text(entry.topic, `facts[${index}].topic`), answer: text(entry.answer, `facts[${index}].answer`) };
  });
  let transfer: ProfileDraft['transfer'] = null;
  if (raw.transfer !== null && raw.transfer !== undefined) {
    if (!isRecord(raw.transfer)) throw new HttpError(400, _('"transfer" must be an object or null'));
    transfer = { announce: text(raw.transfer.announce, 'transfer.announce') };
  }
  let transferTarget: string | undefined;
  if (raw.transferTarget !== undefined && raw.transferTarget !== null && raw.transferTarget !== '') {
    transferTarget = normalizeTarget(text(raw.transferTarget, 'transferTarget'));
  }
  const fallback =
    raw.fallback === null || raw.fallback === undefined || raw.fallback === '' ? null : text(raw.fallback, 'fallback');
  return {
    assistantName: text(raw.assistantName, 'assistantName'),
    greeting: text(raw.greeting, 'greeting'),
    instructions: text(raw.instructions, 'instructions'),
    facts,
    transfer,
    ...(transferTarget && { transferTarget }),
    fallback,
  };
}

/** The file's JSON as written, for a draft to be laid over; never the parsed `Profile`. */
function readRaw(path: string, name: string): { raw: Raw; revision: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new HttpError(404, _('no profile %s').replace('%s', name));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  if (!isRecord(raw)) throw new HttpError(400, _('top level must be an object'));
  return { raw, revision: revisionOf(bytes) };
}

/**
 * `raw` with the draft laid over it. Assigning to an existing key keeps its place, and anything the
 * draft does not name stays exactly as it was. Throws the parser's own message when the result is
 * not a profile a call could start with.
 */
export function applyDraft(raw: Raw, draft: ProfileDraft, name: string): { json: Raw; profile: Profile } {
  const next: Raw = { ...raw };
  next.assistantName = draft.assistantName;
  next.greeting = draft.greeting;
  next.instructions = draft.instructions;
  next.facts = draft.facts.map((fact) => ({ topic: fact.topic, answer: fact.answer }));
  if (draft.transfer === null) {
    delete next.transfer;
  } else {
    const previous = isRecord(raw.transfer) ? raw.transfer : {};
    const target = draft.transferTarget ?? previous.target;
    if (typeof target !== 'string' || target === '') {
      throw new HttpError(400, _('a transfer needs a target: enter a phone number'));
    }
    next.transfer = { ...previous, announce: draft.transfer.announce, target };
  }
  if (draft.fallback === null) delete next.fallback;
  else next.fallback = draft.fallback;
  try {
    return { json: next, profile: parseProfile(next, name) };
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

export function draftView(profile: Profile): DraftView {
  return {
    assistantName: profile.assistantName,
    greeting: profile.greeting,
    instructions: profile.instructions,
    facts: profile.facts,
    transfer: profile.transfer
      ? { announce: profile.transfer.announce, targetMasked: maskTransferTarget(profile.transfer.target) }
      : null,
    fallback: profile.fallback ?? null,
  };
}

const stampOf = (date: Date): string => date.toISOString().replaceAll(':', '-');
const dateOf = (stamp: string): Date => new Date(stamp.replace(new RegExp('T(\\d+)-(\\d+)-'), 'T$1:$2:'));

export function createProfileStore(env: NodeJS.ProcessEnv, now: () => Date = () => new Date()) {
  const dir = (): string => profilesDir(env);
  const historyDir = (): string => join(dir(), HISTORY_DIR);

  const pathOf = (file: string): string => {
    const path = profileFilePath(file, env);
    if (!path) throw new HttpError(400, _('"file" must be the name of a .json file in the profiles directory'));
    return path;
  };

  const versionPath = (file: string, version: string): string => {
    if (!STAMP.test(version)) throw new HttpError(400, _('invalid version'));
    const path = resolve(historyDir(), `${file}.${version}.json`);
    // The stamp pattern already excludes separators; this is the second lock on the same door.
    if (dirname(path) !== resolve(historyDir()) || !basename(path).startsWith(`${file}.`)) {
      throw new HttpError(400, _('invalid version'));
    }
    return path;
  };

  const versionsOf = (file: string): string[] => {
    let names: string[];
    try {
      names = readdirSync(historyDir());
    } catch {
      return [];
    }
    const prefix = `${file}.`;
    return names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .map((name) => name.slice(prefix.length, -'.json'.length))
      .filter((stamp) => STAMP.test(stamp))
      .sort()
      .reverse();
  };

  /** Copies the file as it is now into `.history/` and drops what is beyond the newest 20. */
  const snapshot = (file: string, path: string): void => {
    mkdirSync(historyDir(), { recursive: true });
    let at = now();
    for (;;) {
      const target = join(historyDir(), `${file}.${stampOf(at)}.json`);
      if (!existsSync(target)) {
        copyFileSync(path, target);
        break;
      }
      at = new Date(at.getTime() + 1);
    }
    for (const stale of versionsOf(file).slice(HISTORY_KEEP))
      rmSync(join(historyDir(), `${file}.${stale}.json`), { force: true });
  };

  /** Temp file next to the target, then a rename: a reader sees the old file or the new one. */
  const writeAtomic = (path: string, content: string): void => {
    const mode = statSync(path).mode & 0o777;
    const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, content, { mode });
      chmodSync(temp, mode);
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  };

  const serialize = (json: Raw): string => `${JSON.stringify(json, null, 2)}\n`;

  return {
    /** The file's revision, or undefined when it is not there. */
    revision(file: string): string | undefined {
      try {
        return revisionOf(readFileSync(pathOf(file)));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        return undefined;
      }
    },

    save(file: string, revision: unknown, draftInput: unknown): { revision: string } {
      const path = pathOf(file);
      if (typeof revision !== 'string' || revision === '') {
        throw new HttpError(400, _('"revision" must be the revision the page loaded'));
      }
      const draft = parseDraft(draftInput);
      const current = readRaw(path, file);
      if (current.revision !== revision) {
        throw new HttpError(409, _('the profile changed since you loaded it: reload it and make the change again'));
      }
      const { json } = applyDraft(current.raw, draft, file);
      snapshot(file, path);
      const content = serialize(json);
      writeAtomic(path, content);
      return { revision: revisionOf(content) };
    },

    history(file: string): HistoryEntry[] {
      pathOf(file);
      return versionsOf(file).map((version) => ({
        version,
        at: dateOf(version).toISOString(),
        size: statSync(join(historyDir(), `${file}.${version}.json`)).size,
      }));
    },

    restore(file: string, version: unknown): { revision: string } {
      const path = pathOf(file);
      if (typeof version !== 'string') throw new HttpError(400, _('invalid version'));
      const source = versionPath(file, version);
      let bytes: Buffer;
      try {
        bytes = readFileSync(source);
      } catch {
        throw new HttpError(404, _('no such version'));
      }
      let json: unknown;
      try {
        json = JSON.parse(bytes.toString('utf8'));
        parseProfile(json, file);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      if (!existsSync(path)) throw new HttpError(404, _('no profile %s').replace('%s', file));
      snapshot(file, path);
      writeAtomic(path, bytes.toString('utf8'));
      return { revision: revisionOf(bytes) };
    },

    /** A new file in the profiles directory from a profile's JSON; never overwrites. */
    create(file: string, source: Raw, sourceDir: string): void {
      const path = pathOf(file);
      if (existsSync(path)) throw new HttpError(409, _('a profile with this name already exists'));
      const json: Raw = { ...source };
      // A reference clip is relative to the file it sits in; the copy lives elsewhere.
      if (isRecord(source.voice) && typeof source.voice.refAudio === 'string') {
        json.voice = { ...source.voice, refAudio: resolve(sourceDir, source.voice.refAudio) };
      }
      try {
        parseProfile(json, file);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      mkdirSync(dir(), { recursive: true });
      writeFileSync(path, serialize(json), { flag: 'wx' });
    },

    /** The raw JSON and revision of a profiles-directory file. */
    readRaw: (file: string) => readRaw(pathOf(file), file),
  };
}

export type ProfileStore = ReturnType<typeof createProfileStore>;
