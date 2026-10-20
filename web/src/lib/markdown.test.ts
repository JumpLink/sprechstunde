import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inline, parseMarkdown } from './markdown.js';

test('parseMarkdown: headings, paragraphs, lists, code and rules', () => {
  const blocks = parseMarkdown('# Menu\n\nSoup\nand bread\n\n- a\n- b\n\n```\n<b>x</b>\n```\n---');
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['heading', 'paragraph', 'list', 'code', 'rule'],
  );
  assert.deepEqual(blocks[1], { type: 'paragraph', inline: [{ text: 'Soup and bread' }] });
  assert.deepEqual(blocks[3], { type: 'code', text: '<b>x</b>' });
});

test('inline: bold, code and links; only web addresses stay links', () => {
  assert.deepEqual(inline('a **b** `c` [d](https://x.example/) [e](javascript:void)'), [
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' ' },
    { text: 'c', code: true },
    { text: ' ' },
    { text: 'd', href: 'https://x.example/' },
    { text: ' ' },
    { text: 'e', href: undefined },
  ]);
});
