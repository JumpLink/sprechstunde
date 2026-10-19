import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentSettings } from './settings.js';

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
