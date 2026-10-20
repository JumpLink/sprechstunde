/**
 * A small Markdown reader for the preview. It returns data, not HTML: the page renders the blocks
 * with Svelte, so a fetched text can never inject markup.
 */

export type Inline = { text: string; bold?: boolean; code?: boolean; href?: string };
export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'list'; items: Inline[][] }
  | { type: 'code'; text: string }
  | { type: 'rule' };

const TOKEN = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;

/** Only web and mail addresses become links. */
const safeHref = (href: string): string | undefined => (/^(https?:|mailto:)/i.test(href) ? href : undefined);

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ text: match[1], href: safeHref(match[2]!) });
    else if (match[3] !== undefined) out.push({ text: match[3], bold: true });
    else out.push({ text: match[4]!, code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: Inline[][] | undefined;
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', inline: inline(paragraph.join(' ')) });
    if (list) blocks.push({ type: 'list', items: list });
    paragraph = [];
    list = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) code.push(lines[i]!);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (line.trim() === '') flush();
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
    } else if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1]!.length, inline: inline(heading[2]!) });
    } else if (item) {
      if (paragraph.length > 0) flush();
      (list ??= []).push(inline(item[1]!));
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}
