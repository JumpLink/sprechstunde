import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseProfile } from '../core/profile.js';
import { emptySettings, parseSettings } from '../core/settings.js';
import { characterForCall, currentSettings, profileFileForCall, profileForCall } from './settings.js';

function fileWith(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'sprechstunde-agent-settings-')), 'voice.json');
  writeFileSync(file, content);
  return file;
}

test('currentSettings: no file means no settings, not an error', () => {
  assert.equal(
    currentSettings({
      SPRECHSTUNDE_SETTINGS_FILE: join(tmpdir(), 'does-not-exist-sprechstunde.json'),
    }),
    undefined,
  );
});

test('currentSettings: reads what the admin UI wrote', () => {
  const file = fileWith(
    JSON.stringify({
      schemaVersion: 2,
      characters: [
        {
          id: 'house',
          name: 'House',
          gender: 'female',
          voice: { provider: 'pocket' },
        },
      ],
      defaultCharacter: 'house',
    }),
  );
  assert.equal(currentSettings({ SPRECHSTUNDE_SETTINGS_FILE: file })?.defaultCharacter, 'house');
});

test('currentSettings: a file from before characters still loads', () => {
  const file = fileWith(
    JSON.stringify({
      presets: [{ id: 'house', label: 'House', provider: 'pocket' }],
      active: { primary: 'house' },
    }),
  );
  const settings = currentSettings({ SPRECHSTUNDE_SETTINGS_FILE: file });
  assert.equal(settings?.defaultCharacter, 'house');
  assert.equal(settings?.characters[0]?.tenantId, 'default');
});

test('currentSettings: a broken file warns and leaves the call to the environment', () => {
  const file = fileWith('{ "presets": [{ "id": "x" }] }');
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    assert.equal(currentSettings({ SPRECHSTUNDE_SETTINGS_FILE: file }), undefined);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
});

function profilesWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sprechstunde-profiles-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const profileJson = (id: string) =>
  JSON.stringify({
    id,
    locale: 'de-DE',
    timeZone: 'Europe/Berlin',
    assistantName: 'Test',
    greeting: 'Hallo, ich bin eine KI.',
    instructions: 'Be brief.',
    facts: [],
  });

const START = { ...parseProfile(JSON.parse(profileJson('start'))) };

test('profileForCall: no choice means the start profile', () => {
  assert.equal(profileForCall(START, undefined), START);
  assert.equal(profileForCall(START, emptySettings()), START);
});

test('profileForCall: loads the chosen file from the profiles directory', () => {
  const dir = profilesWith({ 'other.json': profileJson('other') });
  const env = { SPRECHSTUNDE_PROFILES_DIR: dir };
  assert.equal(profileForCall(START, { ...emptySettings(), profile: 'other.json' }, undefined, env).id, 'other');
});

test('profileForCall: a line assignment beats the picked profile, which beats the start profile', () => {
  const dir = profilesWith({ 'other.json': profileJson('other'), 'lined.json': profileJson('lined') });
  const env = { SPRECHSTUNDE_PROFILES_DIR: dir };
  const settings = { ...emptySettings(), profile: 'other.json', lines: { test: 'lined.json' } };
  assert.equal(profileForCall(START, settings, 'test', env).id, 'lined');
  assert.equal(profileForCall(START, settings, 'main', env).id, 'other');
  assert.equal(profileForCall(START, settings, undefined, env).id, 'other');
  assert.equal(profileForCall(START, { ...emptySettings(), lines: { test: 'lined.json' } }, 'main', env), START);
  assert.equal(profileFileForCall(settings, 'test'), 'lined.json');
  assert.equal(profileFileForCall(settings, 'main'), 'other.json');
});

test('profileForCall: a file that does not load warns and keeps the start profile', () => {
  const dir = profilesWith({ 'broken.json': '{ "id": "x" }' });
  const env = { SPRECHSTUNDE_PROFILES_DIR: dir };
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    for (const profile of ['broken.json', 'missing.json']) {
      assert.equal(profileForCall(START, { ...emptySettings(), profile }, undefined, env), START);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(JSON.stringify(warnings), /Hallo/);
});

const CHARACTERS = parseSettings({
  schemaVersion: 2,
  characters: [
    { id: 'mia', name: 'Mia', gender: 'female', voice: { provider: 'pocket' } },
    { id: 'bo', name: 'Bo', gender: 'male', voice: { provider: 'pocket' } },
  ],
  defaultCharacter: 'mia',
});

test('characterForCall: venue, then default; a venue without the field gets the default', () => {
  assert.equal(characterForCall(CHARACTERS, { ...START, character: 'bo' })?.id, 'bo');
  assert.equal(characterForCall(CHARACTERS, START)?.id, 'mia');
  assert.equal(characterForCall(undefined, START), undefined);
});

test('characterForCall: an unknown id warns with the id only and the default answers', () => {
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    assert.equal(characterForCall(CHARACTERS, { ...START, character: 'gone' })?.id, 'mia');
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings), /gone/);
  assert.doesNotMatch(JSON.stringify(warnings), /Hallo/);
});
