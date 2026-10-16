import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { languagesFromEnv, parseMo } from './i18n.js';

const msgfmt = spawnSync('msgfmt', ['--version']);
const PO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "Hello"
msgstr "Grüß dich"

msgid "one call"
msgid_plural "%d calls"
msgstr[0] "ein Anruf"
msgstr[1] "%d Anrufe"
`;

test('parses a .mo written by msgfmt', { skip: msgfmt.error !== undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprechstunde-mo-'));
  writeFileSync(join(dir, 't.po'), PO);
  const run = spawnSync('msgfmt', ['-o', join(dir, 't.mo'), join(dir, 't.po')]);
  assert.equal(run.status, 0);
  const catalog = parseMo(readFileSync(join(dir, 't.mo')));
  assert.equal(catalog.messages.get('Hello'), 'Grüß dich');
  const forms = catalog.messages.get('one call\0%d calls')?.split('\0');
  assert.deepEqual(forms, ['ein Anruf', '%d Anrufe']);
  assert.equal(catalog.plural(1), 0);
  assert.equal(catalog.plural(2), 1);
});

test('parses a big-endian .mo', () => {
  // header + one entry, hand-built big-endian
  const original = Buffer.from('Hi');
  const translated = Buffer.from('Hallo');
  const head = Buffer.alloc(28 + 16);
  head.writeUInt32BE(0x950412de, 0);
  head.writeUInt32BE(0, 4);
  head.writeUInt32BE(1, 8);
  head.writeUInt32BE(28, 12);
  head.writeUInt32BE(36, 16);
  head.writeUInt32BE(original.length, 28);
  head.writeUInt32BE(44, 32);
  head.writeUInt32BE(translated.length, 36);
  head.writeUInt32BE(44 + original.length + 1, 40);
  const file = Buffer.concat([head, original, Buffer.from([0]), translated, Buffer.from([0])]);
  assert.equal(parseMo(file).messages.get('Hi'), 'Hallo');
});

test('rejects a file with a bad magic number', () => {
  assert.throws(() => parseMo(Buffer.alloc(32)), /magic/);
});

test('languagesFromEnv prefers LANGUAGE and adds the short form', () => {
  assert.deepEqual(languagesFromEnv({ LANGUAGE: 'de_DE.UTF-8:en', LANG: 'C' }), ['de_DE', 'de', 'en']);
  assert.deepEqual(languagesFromEnv({ LANG: 'C' }), []);
});
