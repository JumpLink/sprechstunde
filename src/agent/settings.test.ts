import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseProfile } from '../core/profile.js';
import { emptySettings } from '../core/settings.js';
import { currentSettings, profileForCall } from './settings.js';

function fileWith(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'sprechstunde-agent-settings-')), 'voice.json');
  writeFileSync(file, content);
  return file;
}

test('currentSettings: no file means no settings, not an error', () => {
  assert.equal(
    currentSettings({ SPRECHSTUNDE_SETTINGS_FILE: join(tmpdir(), 'does-not-exist-sprechstunde.json') }),
    undefined,
  );
});

test('currentSettings: reads what the admin UI wrote', () => {
  const file = fileWith(
    JSON.stringify({ presets: [{ id: 'house', label: 'House', provider: 'pocket' }], active: { primary: 'house' } }),
  );
  assert.equal(currentSettings({ SPRECHSTUNDE_SETTINGS_FILE: file })?.active.primary, 'house');
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
  assert.equal(profileForCall(START, { ...emptySettings(), profile: 'other.json' }, env).id, 'other');
});

test('profileForCall: a file that does not load warns and keeps the start profile', () => {
  const dir = profilesWith({ 'broken.json': '{ "id": "x" }' });
  const env = { SPRECHSTUNDE_PROFILES_DIR: dir };
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    for (const profile of ['broken.json', 'missing.json']) {
      assert.equal(profileForCall(START, { ...emptySettings(), profile }, env), START);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(JSON.stringify(warnings), /Hallo/);
});
