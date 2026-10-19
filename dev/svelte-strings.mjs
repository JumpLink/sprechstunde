// xgettext cannot read .svelte files. This copies the `_('…')` marker calls out of each one into a
// plain .js file with the same path under the target directory, keeping the line numbers, so the
// references in the .pot still point at the component. Markup and script are not parsed: a marker
// is a call to `_` with a string literal, wherever it stands.
//
//   node dev/svelte-strings.mjs <target-dir> <file.svelte>...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [target, ...files] = process.argv.slice(2);
if (!target || files.length === 0) {
  process.stderr.write('usage: svelte-strings.mjs <target-dir> <file.svelte>...\n');
  process.exit(2);
}

const CALL = /(?<![\w$.])_\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")\s*\)/g;

for (const file of files) {
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => [...line.matchAll(CALL)].map((match) => `_(${match[1]});`).join(' '));
  const out = join(target, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'));
}
