import { api, preview, revoke } from './api';
import type { Catalog, CatalogVoice, Gender, Provider, VoiceSpec } from './types';

/** The preview endpoint refuses more than this many characters (`MAX_PREVIEW_CHARS` in the server). */
export const MAX_PREVIEW_CHARS = 1000;

/** A voice somebody could be cast with. */
export interface Candidate {
  provider: Provider;
  model?: string;
  voice: string;
  name: string;
  /** Only what the vendor reports; unset means unknown. */
  gender?: Gender;
  description?: string;
}

export const specKey = (spec: { provider: string; model?: string; voice?: string }): string =>
  [spec.provider, spec.model ?? '', spec.voice ?? ''].join('|');

export const specOf = (candidate: Candidate): VoiceSpec => ({
  provider: candidate.provider,
  ...(candidate.model && { model: candidate.model }),
  ...(candidate.voice && { voice: candidate.voice }),
});

const speaksLanguage = (voice: CatalogVoice, provider: string, language: string): boolean =>
  voice.languages.some((tag) => tag === language || tag.startsWith(`${language}-`)) ||
  // A local Pocket server speaks the one language it was set up with; when it does not say which, it is the deployment's.
  (provider === 'pocket' && voice.languages.length === 0);

export function candidatesFrom(catalogs: Array<Catalog | undefined>, language: string): Candidate[] {
  const result: Candidate[] = [];
  for (const catalog of catalogs) {
    if (!catalog?.available) continue;
    for (const voice of catalog.voices) {
      if (!speaksLanguage(voice, catalog.provider, language)) continue;
      result.push({
        provider: catalog.provider as Provider,
        ...(voice.model && { model: voice.model }),
        voice: voice.id,
        name: voice.name,
        ...(voice.gender && { gender: voice.gender }),
        ...(voice.description && { description: voice.description }),
      });
    }
  }
  return result;
}

/** The candidates a gender asks for: the voices the vendor says match, and the ones it says nothing about. */
export function poolFor(candidates: Candidate[], gender: Gender): { known: Candidate[]; unknown: Candidate[] } {
  const unknown = candidates.filter((candidate) => !candidate.gender);
  // Neutral is not a filter: few vendors report it, and any voice may be cast as a neutral character.
  const known = candidates.filter(
    (candidate) => candidate.gender && (gender === 'neutral' || candidate.gender === gender),
  );
  return { known, unknown };
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** `count` voices mixed across vendors, preferring ones not shown before; `seen` is added to. */
export function mixOf(pool: Candidate[], count: number, seen: Set<string>): Candidate[] {
  let fresh = pool.filter((candidate) => !seen.has(specKey(specOf(candidate))));
  if (fresh.length < Math.min(count, pool.length)) {
    seen.clear();
    fresh = pool;
  }
  const byVendor = new Map<string, Candidate[]>();
  for (const candidate of shuffled(fresh)) {
    byVendor.set(candidate.provider, [...(byVendor.get(candidate.provider) ?? []), candidate]);
  }
  const queues = shuffled([...byVendor.values()]);
  const picked: Candidate[] = [];
  while (picked.length < count && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && picked.length < count) picked.push(next);
    }
  }
  for (const candidate of picked) seen.add(specKey(specOf(candidate)));
  return picked;
}

/**
 * The fallback that is pre-selected: another vendor than the primary, the same gender when the
 * vendor says so, and a local Pocket voice first, because it does not fail with the network.
 */
export function defaultFallback(
  primary: { provider: string; gender?: Gender },
  candidates: Candidate[],
): Candidate | undefined {
  const others = candidates.filter((candidate) => candidate.provider !== primary.provider);
  const score = (candidate: Candidate): number =>
    (candidate.gender && candidate.gender === primary.gender ? 2 : candidate.gender ? 0 : 1) +
    (candidate.provider === 'pocket' ? 3 : 0);
  return others.toSorted((a, b) => score(b) - score(a))[0];
}

/** The venue's greeting with the new name in place of the one it carries, as a call would say it. */
export function greetingWithName(greeting: string, oldName: string, newName: string): string {
  const name = newName.trim();
  if (!name || !oldName || name === oldName) return greeting.slice(0, MAX_PREVIEW_CHARS);
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
  return greeting.replace(mention, name).slice(0, MAX_PREVIEW_CHARS);
}

export interface VenueGreeting {
  greeting: string;
  assistantName: string;
}

let venueGreeting: Promise<VenueGreeting> | undefined;

/** The real greeting of the venue the agent serves, fetched once. */
export function loadGreeting(): Promise<VenueGreeting> {
  venueGreeting ??= api<{ greeting: string; profile: { assistantName: string } }>('GET', '/api/knowledge')
    .then((knowledge) => ({ greeting: knowledge.greeting, assistantName: knowledge.profile.assistantName }))
    .catch((error) => {
      venueGreeting = undefined;
      throw error;
    });
  return venueGreeting;
}

export interface Heard {
  url: string;
  ttfaMs: number;
}

/** Synthesized previews kept per voice, text and quality, so a second click costs nothing. */
export function previewCache() {
  const heard = new Map<string, Promise<Heard>>();
  let playing: HTMLAudioElement | undefined;

  const stop = (): void => {
    playing?.pause();
    playing = undefined;
  };

  return {
    hear(spec: VoiceSpec, text: string, phone: boolean): Promise<Heard> {
      const key = `${specKey(spec)}|${phone}|${text}`;
      let entry = heard.get(key);
      if (!entry) {
        entry = preview({ voice: spec }, text, phone);
        heard.set(key, entry);
        entry.catch(() => heard.delete(key));
      }
      return entry;
    },
    /** Resolves when the sound ends or is cut off by another one. */
    play(url: string): Promise<void> {
      stop();
      const audio = new Audio(url);
      playing = audio;
      return new Promise((resolve) => {
        audio.onended = () => resolve();
        audio.onpause = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
    },
    stop,
    clear(): void {
      stop();
      for (const entry of heard.values()) void entry.then((result) => revoke(result.url)).catch(() => {});
      heard.clear();
    },
  };
}
