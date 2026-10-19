// The web app has no .mo reader: this turns a compiled catalogue into a flat msgid -> msgstr JSON.
// Plural entries and untranslated ones are left out.
//
//   node --import tsx dev/mo-to-json.mjs <in.mo> <out.json>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseMo } from '../src/i18n.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write('usage: mo-to-json.mjs <in.mo> <out.json>\n');
  process.exit(2);
}

const flat = {};
for (const [msgid, msgstr] of parseMo(readFileSync(input)).messages) {
  if (msgid && msgstr && !msgid.includes('\0')) flat[msgid] = msgstr;
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(flat, null, 2)}\n`);
