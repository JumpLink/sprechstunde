import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOMAIN = 'sprechstunde';
const MAGIC = 0x950412de;

export interface Catalog {
  /** msgid (plural entries: "singular\0plural") to msgstr (plural entries: forms joined by "\0"). */
  messages: Map<string, string>;
  /** Index of the plural form for n. */
  plural: (n: number) => number;
}

type PluralFn = (n: number) => number;

/** Evaluates the C expression of a Plural-Forms header without eval. */
function compilePlural(expression: string): PluralFn {
  const source = expression.replace(/\s+/g, '');
  const parse = (n: number): number => {
    let pos = 0;
    const peek = (s: string) => source.startsWith(s, pos);
    const eat = (s: string) => (peek(s) ? ((pos += s.length), true) : false);

    const primary = (): number => {
      if (eat('(')) {
        const value = ternary();
        eat(')');
        return value;
      }
      if (eat('!')) return primary() ? 0 : 1;
      if (eat('n')) return n;
      const match = /^\d+/.exec(source.slice(pos));
      if (!match) throw new Error(`bad plural expression: ${expression}`);
      pos += match[0].length;
      return Number(match[0]);
    };
    const binary = (next: () => number, ops: Array<[string, (a: number, b: number) => number]>) => () => {
      let left = next();
      for (;;) {
        const op = ops.find(([symbol]) => peek(symbol));
        if (!op) return left;
        pos += op[0].length;
        left = op[1](left, next());
      }
    };
    const mul = binary(primary, [['%', (a, b) => (b === 0 ? 0 : a % b)]]);
    const rel = binary(mul, [
      ['<=', (a, b) => Number(a <= b)],
      ['>=', (a, b) => Number(a >= b)],
      ['<', (a, b) => Number(a < b)],
      ['>', (a, b) => Number(a > b)],
    ]);
    const eq = binary(rel, [
      ['==', (a, b) => Number(a === b)],
      ['!=', (a, b) => Number(a !== b)],
    ]);
    const and = binary(eq, [['&&', (a, b) => Number(Boolean(a) && Boolean(b))]]);
    const or = binary(and, [['||', (a, b) => Number(Boolean(a) || Boolean(b))]]);
    function ternary(): number {
      const condition = or();
      if (!eat('?')) return condition;
      const yes = ternary();
      eat(':');
      const no = ternary();
      return condition ? yes : no;
    }
    return ternary();
  };
  return (n) => parse(n);
}

const germanicPlural: PluralFn = (n) => (n === 1 ? 0 : 1);

/** Parse the content of a GNU .mo file (either byte order). */
export function parseMo(buffer: Buffer): Catalog {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = view.getUint32(0, true);
  let little: boolean;
  if (magic === MAGIC) little = true;
  else if (view.getUint32(0, false) === MAGIC) little = false;
  else throw new Error('Not a .mo file: bad magic number');

  const count = view.getUint32(8, little);
  const originals = view.getUint32(12, little);
  const translations = view.getUint32(16, little);
  const text = (table: number, index: number) => {
    const length = view.getUint32(table + index * 8, little);
    const offset = view.getUint32(table + index * 8 + 4, little);
    return buffer.toString('utf8', offset, offset + length);
  };

  const messages = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    messages.set(text(originals, index), text(translations, index));
  }

  let plural = germanicPlural;
  const header = /plural=([^;]+);?/.exec(messages.get('') ?? '');
  if (header?.[1]) plural = compilePlural(header[1]);
  return { messages, plural };
}

export function languagesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.LANGUAGE || env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  const result: string[] = [];
  for (const entry of raw.split(':')) {
    const base = entry.replace(/[.@].*$/, '');
    if (!base || base === 'C' || base === 'POSIX') continue;
    result.push(base);
    const short = base.split('_')[0];
    if (short && short !== base) result.push(short);
  }
  return result;
}

function localeRoots(): string[] {
  return [
    fileURLToPath(new URL('./locale/', import.meta.url)),
    fileURLToPath(new URL('../dist/locale/', import.meta.url)),
  ];
}

export function loadCatalog(
  languages: string[] = languagesFromEnv(),
  roots: string[] = localeRoots(),
): Catalog | null {
  for (const language of languages) {
    for (const root of roots) {
      try {
        return parseMo(readFileSync(`${root}${language}/LC_MESSAGES/${DOMAIN}.mo`));
      } catch {
        // not there; try the next candidate
      }
    }
  }
  return null;
}

let catalog: Catalog | null | undefined;

function current(): Catalog | null {
  if (catalog === undefined) catalog = loadCatalog();
  return catalog;
}

/** Translate a message; falls back to the English msgid. */
export function _(msgid: string): string {
  const translated = current()?.messages.get(msgid);
  return translated || msgid;
}

/** Translate a message with plural forms. */
export function _n(singular: string, plural: string, n: number): string {
  const cat = current();
  const forms = cat?.messages.get(`${singular}\0${plural}`)?.split('\0');
  const form = forms?.[cat?.plural(n) ?? 0];
  if (form) return form;
  return n === 1 ? singular : plural;
}
