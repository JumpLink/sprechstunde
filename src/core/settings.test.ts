import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  characterFor,
  defaultCharacter,
  findCharacter,
  emptySettings,
  parseSettings,
  profileFilePath,
  readSettings,
  settingsFile,
  type Settings,
  voiceRefAudioPath,
  writeSettings,
} from './settings.js';

const character = (overrides: Record<string, unknown> = {}) => ({
  id: 'mia',
  name: 'Mia',
  gender: 'female',
  voice: { provider: 'mistral' },
  ...overrides,
});
const doc = (characters: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  characters,
  ...extra,
});

// The shape voice.json had before characters existed; the values are made up.
const preset = (overrides: Record<string, unknown> = {}) => ({
  id: 'house',
  label: 'House voice',
  provider: 'mistral',
  ...overrides,
});

function temporaryDir(): string {
  return mkdtempSync(join(tmpdir(), 'sprechstunde-settings-'));
}

test('parseSettings: an empty object is valid and means "nothing configured"', () => {
  assert.deepEqual(parseSettings({}), emptySettings());
  assert.equal(emptySettings().schemaVersion, 2);
});

test('parseSettings: a character keeps only the fields it has and always has a tenant', () => {
  const settings = parseSettings(doc([character({ extra: 'ignored', tone: ' warm ', color: '#AABBCC' })]));
  assert.deepEqual(settings.characters, [
    {
      id: 'mia',
      tenantId: 'default',
      name: 'Mia',
      gender: 'female',
      voice: { provider: 'mistral' },
      tone: 'warm',
      color: '#aabbcc',
    },
  ]);
});

test('parseSettings: empty strings count as absent, not as values', () => {
  const settings = parseSettings(
    doc([
      character({
        voice: { provider: 'mistral', model: '', voice: '' },
        tone: '',
      }),
    ]),
  );
  assert.deepEqual(Object.keys(settings.characters[0]!.voice), ['provider']);
  assert.equal('tone' in settings.characters[0]!, false);
});

test('parseSettings: rejects a bad character', () => {
  assert.throws(() => parseSettings(doc([character({ id: 'has space' })])), /"id"/);
  assert.throws(() => parseSettings(doc([character({ id: 'default' })])), /"id"/);
  assert.throws(() => parseSettings(doc([character({ name: '  ' })])), /"name"/);
  assert.throws(() => parseSettings(doc([character({ name: 'a\nb' })])), /"name"/);
  assert.throws(() => parseSettings(doc([character({ name: 'x'.repeat(61) })])), /"name"/);
  assert.throws(() => parseSettings(doc([character({ gender: 'robot' })])), /"gender"/);
  assert.throws(() => parseSettings(doc([character({ tone: 'a\u0007b' })])), /"tone"/);
  assert.throws(() => parseSettings(doc([character({ tone: 'x'.repeat(301) })])), /"tone"/);
  assert.throws(() => parseSettings(doc([character({ color: 'red' })])), /"color"/);
  assert.throws(() => parseSettings(doc([character({ tenantId: 'no way' })])), /tenant/);
  assert.throws(() => parseSettings(doc([character({ voice: { provider: 'elevenlabs' } })])), /"provider"/);
  assert.throws(
    () =>
      parseSettings(
        doc([
          character({
            voice: { provider: 'mistral', voice: 'v', refAudio: 'clip.wav' },
          }),
        ]),
      ),
    /mutually/,
  );
  assert.throws(() => parseSettings({ schemaVersion: 3, characters: [] }), /schemaVersion/);
});

test('parseSettings: a vendor without a default voice needs one', () => {
  for (const provider of ['cartesia', 'openrouter', 'kugel']) {
    assert.throws(() => parseSettings(doc([character({ voice: { provider } })])), /"voice" is required/);
  }
  assert.equal(
    parseSettings(doc([character({ voice: { provider: 'pocket' } })])).characters[0]!.voice.voice,
    undefined,
  );
});

test('parseSettings: a kugel voice is a numeric vendor id', () => {
  const kugel = (voice: string) => doc([character({ voice: { provider: 'kugel', voice } })]);
  assert.throws(() => parseSettings(kugel('ernst')), /numeric voice id/);
  assert.equal(parseSettings(kugel('7')).characters[0]!.voice.voice, '7');
  // Beyond nine digits the id could stop being a safe integer once it goes through Number().
  assert.throws(() => parseSettings(kugel('1234567890')), /numeric voice id/);
});

test('parseSettings: only Mistral clones a reference clip', () => {
  assert.throws(
    () => parseSettings(doc([character({ voice: { provider: 'pocket', refAudio: 'clip.wav' } })])),
    /refAudio/,
  );
  const clone = parseSettings(doc([character({ voice: { provider: 'mistral', refAudio: 'clip.wav' } })]));
  assert.equal(clone.characters[0]!.voice.refAudio, 'clip.wav');
});

test('parseSettings: character ids are unique per tenant', () => {
  assert.throws(() => parseSettings(doc([character(), character({ name: 'Second' })])), /duplicate character id/);
  const two = parseSettings(doc([character(), character({ tenantId: 'other' })]));
  assert.equal(two.characters.length, 2);
});

test('parseSettings: the default character must exist', () => {
  assert.throws(() => parseSettings(doc([character()], { defaultCharacter: 'gone' })), /names no character/);
  assert.equal(parseSettings(doc([character()], { defaultCharacter: 'mia' })).defaultCharacter, 'mia');
});

test('parseSettings: the LLM timeout is a number of seconds in a sane range', () => {
  assert.equal(parseSettings({ llm: { attemptTimeoutS: 2.5 } }).llm.attemptTimeoutS, 2.5);
  assert.deepEqual(parseSettings({ llm: { model: 'a', fallbackModel: 'b' } }).llm, { model: 'a', fallbackModel: 'b' });
  assert.throws(() => parseSettings({ llm: { attemptTimeoutS: 0 } }), /attemptTimeoutS/);
  assert.throws(() => parseSettings({ llm: { attemptTimeoutS: '3' } }), /attemptTimeoutS/);
  assert.throws(() => parseSettings({ llm: { attemptTimeoutS: 1000 } }), /attemptTimeoutS/);
});

test('migration: every preset becomes a character, the active pair the default one', () => {
  const settings = parseSettings({
    presets: [
      preset({ id: 'house', label: 'House voice', name: 'Alex', model: 'm' }),
      preset({ id: 'backup', label: 'Backup', provider: 'pocket' }),
      preset({
        id: 'spare',
        label: 'Spare',
        provider: 'cartesia',
        voice: 'v1',
      }),
    ],
    active: { primary: 'house', fallback: 'backup' },
    llm: { model: 'small' },
    profile: 'venue.json',
  });
  assert.equal(settings.schemaVersion, 2);
  assert.deepEqual(
    settings.characters.map((entry) => [entry.id, entry.name, entry.gender, entry.genderUnknown, entry.tenantId]),
    [
      ['house', 'Alex', 'neutral', true, 'default'],
      ['backup', 'Backup', 'neutral', true, 'default'],
      ['spare', 'Spare', 'neutral', true, 'default'],
    ],
  );
  assert.equal(settings.defaultCharacter, 'house');
  assert.deepEqual(settings.characters[0]!.voice, {
    provider: 'mistral',
    model: 'm',
  });
  assert.deepEqual(settings.characters[0]!.fallbackVoice, {
    provider: 'pocket',
  });
  assert.equal(settings.characters[1]!.fallbackVoice, undefined);
  assert.deepEqual(settings.llm, { model: 'small' });
  assert.equal(settings.profile, 'venue.json');
});

test('migration: no active pair means no default character; a preset called "default" is renamed', () => {
  const none = parseSettings({ presets: [preset()] });
  assert.equal(none.defaultCharacter, undefined);
  const renamed = parseSettings({
    presets: [preset({ id: 'default' })],
    active: { primary: 'default' },
  });
  assert.equal(renamed.characters[0]!.id, 'default-voice');
  assert.equal(renamed.defaultCharacter, 'default-voice');
});

test('migration: the old validation still applies', () => {
  assert.throws(() => parseSettings({ presets: [preset({ provider: 'elevenlabs' })] }), /"provider"/);
  assert.throws(() => parseSettings({ presets: [preset(), preset({ label: 'Second' })] }), /duplicate preset id/);
  assert.throws(() => parseSettings({ presets: [preset()], active: 1 }), /"active"/);
  assert.throws(() => parseSettings({ presets: [preset()], active: { primary: 'gone' } }), /names no preset/);
  const presets = [preset()];
  assert.throws(
    () =>
      parseSettings({
        presets,
        active: { primary: 'house', fallback: 'house' },
      }),
    /different/,
  );
  assert.throws(() => parseSettings({ presets, active: { fallback: 'house' } }), /needs an active/);
});

test('findCharacter / defaultCharacter: every lookup names the tenant', () => {
  const settings = parseSettings(
    doc([character(), character({ id: 'bo', tenantId: 'other' })], {
      defaultCharacter: 'mia',
    }),
  );
  assert.equal(findCharacter(settings, 'default', 'mia')?.name, 'Mia');
  assert.equal(findCharacter(settings, 'other', 'mia'), undefined);
  assert.equal(findCharacter(settings, 'default', 'bo'), undefined);
  assert.equal(findCharacter(settings, 'default', undefined), undefined);
  assert.equal(defaultCharacter(settings)?.id, 'mia');
  assert.equal(defaultCharacter(undefined), undefined);
});

test('characterFor: the venue picks, an unknown or missing pick falls back to the default', () => {
  const settings = parseSettings(
    doc([character(), character({ id: 'bo', name: 'Bo', gender: 'male' })], {
      defaultCharacter: 'mia',
    }),
  );
  assert.equal(characterFor(settings, 'bo').character?.id, 'bo');
  assert.deepEqual(characterFor(settings, undefined), {
    character: settings.characters[0],
  });
  const unknown = characterFor(settings, 'gone');
  assert.equal(unknown.character?.id, 'mia');
  assert.equal(unknown.unknown, 'gone');
  // No default either: the environment decides.
  assert.deepEqual(characterFor(parseSettings(doc([character()])), 'gone'), {
    unknown: 'gone',
  });
  assert.deepEqual(characterFor(undefined, undefined), {});
});

test('settingsFile: the default path, overridable', () => {
  assert.equal(settingsFile({}), 'var/settings/voice.json');
  assert.equal(settingsFile({ SPRECHSTUNDE_SETTINGS_FILE: '/tmp/x.json' }), '/tmp/x.json');
});

test('readSettings: a missing or empty file is not an error', () => {
  const dir = temporaryDir();
  assert.equal(readSettings(join(dir, 'nothing.json')), undefined);
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, '   \n');
  assert.equal(readSettings(empty), undefined);
});

test('readSettings: broken content names the file', () => {
  const dir = temporaryDir();
  const file = join(dir, 'voice.json');
  writeFileSync(file, '{ not json');
  assert.throws(() => readSettings(file), /not valid JSON/);
  writeFileSync(file, JSON.stringify(doc([character({ voice: { provider: 'nope' } })])));
  assert.throws(() => readSettings(file), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('writeSettings: creates the directory, writes atomically and reads back', () => {
  const dir = temporaryDir();
  const file = join(dir, 'nested', 'voice.json');
  const settings: Settings = parseSettings({
    ...doc([character({ voice: { provider: 'mistral', model: 'm' } })], {
      defaultCharacter: 'mia',
    }),
    llm: { model: 'small', attemptTimeoutS: 3 },
  });
  writeSettings(file, settings);
  assert.deepEqual(readSettings(file), settings);
  // No leftover temporary file: a reader only ever sees the finished document.
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['voice.json']);
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));

  writeSettings(file, emptySettings());
  assert.deepEqual(readSettings(file), emptySettings());
});

test('parseSettings: refAudio must stay inside the voices directory', () => {
  const env = process.env.SPRECHSTUNDE_VOICES_DIR;
  delete process.env.SPRECHSTUNDE_VOICES_DIR;
  try {
    for (const bad of ['/etc/passwd', '../secret.wav', 'a/../../x.wav', '..']) {
      assert.throws(
        () => parseSettings(doc([character({ voice: { provider: 'mistral', refAudio: bad } })])),
        /voices directory/,
        bad,
      );
    }
    assert.equal(
      parseSettings(doc([character({ voice: { provider: 'mistral', refAudio: 'sub/a.wav' } })])).characters[0]!.voice
        .refAudio,
      'sub/a.wav',
    );
  } finally {
    if (env !== undefined) process.env.SPRECHSTUNDE_VOICES_DIR = env;
  }
});

test('voiceRefAudioPath resolves against SPRECHSTUNDE_VOICES_DIR', () => {
  const env = { SPRECHSTUNDE_VOICES_DIR: '/srv/voices' };
  assert.equal(voiceRefAudioPath('clip.wav', env), '/srv/voices/clip.wav');
  assert.equal(voiceRefAudioPath('../clip.wav', env), null);
  assert.equal(voiceRefAudioPath('/srv/voices/clip.wav', env), null);
});

test('parseSettings: a profile is a plain .json file name, old files have none', () => {
  assert.equal(parseSettings({ profile: 'venue.de.json' }).profile, 'venue.de.json');
  assert.equal('profile' in parseSettings({}), false);
  assert.equal('profile' in parseSettings({ profile: '' }), false);
  for (const bad of ['../x.json', 'a/b.json', '/etc/x.json', '.hidden.json', 'venue.txt', 'venue', 5]) {
    assert.throws(() => parseSettings({ profile: bad }), /profile/, String(bad));
  }
});

test('profileFilePath: stays inside the profiles directory', () => {
  const env = { SPRECHSTUNDE_PROFILES_DIR: '/srv/profiles' };
  assert.equal(profileFilePath('venue.json', env), '/srv/profiles/venue.json');
  assert.equal(profileFilePath('../venue.json', env), null);
  assert.equal(profileFilePath('a/venue.json', env), null);
});

test('parseSettings: lines map line ids to profile files, validated like the profile', () => {
  assert.deepEqual(parseSettings({ lines: { main: 'a.json', 'test-2': 'b.json' } }).lines, {
    main: 'a.json',
    'test-2': 'b.json',
  });
  assert.equal(parseSettings({ lines: {} }).lines, undefined);
  for (const lines of [{ Main: 'a.json' }, { main: '../a.json' }, { main: 'a' }, { main: 1 }, []]) {
    assert.throws(() => parseSettings({ lines }), /lines/);
  }
});
