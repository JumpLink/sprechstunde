/**
 * Wildcard matching without a regular expression: a pattern from a robots.txt or a glob is chosen
 * by whoever runs the site, and `.*a.*a.*a…` backtracks exponentially. This one walks the text once
 * per pattern token (O(pattern × text)) and both are capped, so the cost has a hard ceiling.
 */

export const MAX_PATTERN_CHARS = 200;
export const MAX_TEXT_CHARS = 2048;

type Token = string | typeof ANY | typeof SEGMENT;
const ANY = Symbol('any');
const SEGMENT = Symbol('segment');

/** `*` matches any run of characters; with `segments`, `*` stays inside one path segment and `**` crosses them. */
export function tokenize(pattern: string, segments: boolean): Token[] {
  const tokens: Token[] = [];
  const text = pattern.slice(0, MAX_PATTERN_CHARS);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '*') tokens.push(text[i]!);
    else if (!segments) tokens.push(ANY);
    else if (text[i + 1] === '*') {
      tokens.push(ANY);
      i++;
    } else tokens.push(SEGMENT);
  }
  return tokens;
}

/** Whole-text match, or with `prefix` a match of the start of the text. */
export function matchTokens(tokens: Token[], input: string, prefix: boolean): boolean {
  const text = input.slice(0, MAX_TEXT_CHARS);
  // row[j]: the tokens so far match text[0..j)
  let row = Array.from<boolean>({ length: text.length + 1 }).fill(false);
  row[0] = true;
  for (const token of tokens) {
    const next = Array.from<boolean>({ length: text.length + 1 }).fill(false);
    if (token === ANY || token === SEGMENT) {
      next[0] = row[0]!;
      for (let j = 1; j <= text.length; j++) {
        const crossable = token === ANY || text[j - 1] !== '/';
        next[j] = row[j]! || (next[j - 1]! && crossable);
      }
    } else {
      for (let j = 1; j <= text.length; j++) next[j] = row[j - 1]! && text[j - 1] === token;
    }
    row = next;
  }
  return prefix ? row.some(Boolean) : row[text.length]!;
}
