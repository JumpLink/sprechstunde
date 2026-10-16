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

/** A .mo with nothing but the header entry: the cheapest way to reach the plural compiler. */
function moWithHeader(header: string): Buffer {
  const translation = Buffer.from(header);
  const head = Buffer.alloc(44);
  head.writeUInt32LE(0x950412de, 0);
  head.writeUInt32LE(1, 8);
  head.writeUInt32LE(28, 12);
  head.writeUInt32LE(36, 16);
  head.writeUInt32LE(0, 28);
  head.writeUInt32LE(44, 32);
  head.writeUInt32LE(translation.length, 36);
  head.writeUInt32LE(45, 40);
  return Buffer.concat([head, Buffer.from([0]), translation, Buffer.from([0])]);
}

function pluralOf(expression: string): (n: number) => number {
  return parseMo(moWithHeader(`Plural-Forms: nplurals=3; plural=${expression};\n`)).plural;
}

test('the plural expression of a header decides the form', () => {
  const french = pluralOf('(n > 1)');
  assert.deepEqual([0, 1, 2].map(french), [0, 0, 1]);
  const negated = pluralOf('!(n == 1)');
  assert.deepEqual([1, 3].map(negated), [0, 1]);
});

test('a plural expression with %, && and || keeps C precedence', () => {
  const russian = pluralOf('n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2');
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map(russian), [0, 1, 2, 2, 0, 1, 2]);
});

test('a header without a plural rule falls back to the germanic one', () => {
  const plural = parseMo(moWithHeader('Content-Type: text/plain; charset=UTF-8\n')).plural;
  assert.deepEqual([1, 2].map(plural), [0, 1]);
});

test('rejects a plural expression it cannot parse', () => {
  // The expression is parsed on first use, not when the catalogue loads.
  assert.throws(() => pluralOf('§')(1), /bad plural expression/);
});

test('languagesFromEnv prefers LANGUAGE and adds the short form', () => {
  assert.deepEqual(languagesFromEnv({ LANGUAGE: 'de_DE.UTF-8:en', LANG: 'C' }), ['de_DE', 'de', 'en']);
  assert.deepEqual(languagesFromEnv({ LANG: 'C' }), []);
});
