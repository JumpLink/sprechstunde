import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  activePreset,
  emptySettings,
  parseSettings,
  presetRefAudioPath,
  profileFilePath,
  readSettings,
  settingsFile,
  type Settings,
  writeSettings,
} from './settings.js';

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
});

test('parseSettings: a preset keeps only the fields it has', () => {
  const settings = parseSettings({ presets: [preset({ model: 'm', name: 'Alex', extra: 'ignored' })] });
  assert.deepEqual(settings.presets, [
    { id: 'house', label: 'House voice', provider: 'mistral', model: 'm', name: 'Alex' },
  ]);
});

test('parseSettings: empty strings count as absent, not as values', () => {
  const settings = parseSettings({ presets: [preset({ model: '', voice: '', name: '' })] });
  assert.deepEqual(Object.keys(settings.presets[0]!), ['id', 'label', 'provider']);
});

test('parseSettings: rejects a bad preset', () => {
  assert.throws(() => parseSettings({ presets: [preset({ id: 'has space' })] }), /"id"/);
  assert.throws(() => parseSettings({ presets: [preset({ label: '  ' })] }), /"label"/);
  assert.throws(() => parseSettings({ presets: [preset({ provider: 'elevenlabs' })] }), /"provider"/);
  assert.throws(() => parseSettings({ presets: [preset({ voice: 'v', refAudio: 'clip.wav' })] }), /mutually/);
  assert.throws(() => parseSettings({ presets: [preset()], active: 1 }), /"active"/);
});

test('parseSettings: a vendor without a default voice needs one', () => {
  assert.throws(() => parseSettings({ presets: [preset({ provider: 'cartesia' })] }), /"voice" is required/);
  assert.throws(() => parseSettings({ presets: [preset({ provider: 'openrouter' })] }), /"voice" is required/);
  assert.throws(() => parseSettings({ presets: [preset({ provider: 'kugel' })] }), /"voice" is required/);
  assert.equal(parseSettings({ presets: [preset({ provider: 'pocket' })] }).presets[0]!.voice, undefined);
});

test('parseSettings: a kugel voice is a numeric vendor id', () => {
  assert.throws(() => parseSettings({ presets: [preset({ provider: 'kugel', voice: 'ernst' })] }), /numeric voice id/);
  assert.equal(parseSettings({ presets: [preset({ provider: 'kugel', voice: '7' })] }).presets[0]!.voice, '7');
  // Beyond nine digits the id could stop being a safe integer once it goes through Number().
  assert.throws(
    () => parseSettings({ presets: [preset({ provider: 'kugel', voice: '1234567890' })] }),
    /numeric voice id/,
  );
});

test('parseSettings: only Mistral clones a reference clip', () => {
  assert.throws(() => parseSettings({ presets: [preset({ provider: 'pocket', refAudio: 'clip.wav' })] }), /refAudio/);
  assert.equal(parseSettings({ presets: [preset({ refAudio: 'clip.wav' })] }).presets[0]!.refAudio, 'clip.wav');
});

test('parseSettings: preset ids are unique', () => {
  assert.throws(() => parseSettings({ presets: [preset(), preset({ label: 'Second' })] }), /duplicate preset id/);
});

test('parseSettings: active must name presets that exist', () => {
  assert.throws(() => parseSettings({ presets: [preset()], active: { primary: 'gone' } }), /names no preset/);
  const settings = parseSettings({
    presets: [preset(), preset({ id: 'backup', label: 'Backup', provider: 'pocket' })],
    active: { primary: 'house', fallback: 'backup' },
  });
  assert.deepEqual(settings.active, { primary: 'house', fallback: 'backup' });
});

test('parseSettings: a fallback must differ from the primary and needs one', () => {
  const presets = [preset()];
  assert.throws(() => parseSettings({ presets, active: { primary: 'house', fallback: 'house' } }), /different/);
  assert.throws(() => parseSettings({ presets, active: { fallback: 'house' } }), /needs an active/);
});

test('parseSettings: the LLM timeout is a number of seconds in a sane range', () => {
  assert.equal(parseSettings({ llm: { attemptTimeoutS: 2.5 } }).llm.attemptTimeoutS, 2.5);
  assert.deepEqual(parseSettings({ llm: { model: 'a', fallbackModel: 'b' } }).llm, { model: 'a', fallbackModel: 'b' });
  assert.throws(() => parseSettings({ llm: { attemptTimeoutS: 0 } }), /attemptTimeoutS/);
  assert.throws(() => parseSettings({ llm: { attemptTimeoutS: '3' } }), /attemptTimeoutS/);
  assert.throws(() => parseSettings({ llm: { attemptTimeoutS: 1000 } }), /attemptTimeoutS/);
});

test('activePreset: the preset behind a slot, or nothing', () => {
  const settings = parseSettings({ presets: [preset()], active: { primary: 'house' } });
  assert.equal(activePreset(settings, 'primary')?.label, 'House voice');
  assert.equal(activePreset(settings, 'fallback'), undefined);
  assert.equal(activePreset(undefined, 'primary'), undefined);
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
  writeFileSync(file, JSON.stringify({ presets: [preset({ provider: 'nope' })] }));
  assert.throws(() => readSettings(file), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('writeSettings: creates the directory, writes atomically and reads back', () => {
  const dir = temporaryDir();
  const file = join(dir, 'nested', 'voice.json');
  const settings: Settings = parseSettings({
    presets: [preset({ model: 'm' })],
    active: { primary: 'house' },
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
      assert.throws(() => parseSettings({ presets: [preset({ refAudio: bad })] }), /voices directory/, bad);
    }
    assert.equal(parseSettings({ presets: [preset({ refAudio: 'sub/a.wav' })] }).presets[0]!.refAudio, 'sub/a.wav');
  } finally {
    if (env !== undefined) process.env.SPRECHSTUNDE_VOICES_DIR = env;
  }
});

test('presetRefAudioPath resolves against SPRECHSTUNDE_VOICES_DIR', () => {
  const env = { SPRECHSTUNDE_VOICES_DIR: '/srv/voices' };
  assert.equal(presetRefAudioPath('clip.wav', env), '/srv/voices/clip.wav');
  assert.equal(presetRefAudioPath('../clip.wav', env), null);
  assert.equal(presetRefAudioPath('/srv/voices/clip.wav', env), null);
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
