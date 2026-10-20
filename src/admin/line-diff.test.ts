import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changed, lineDiff } from './line-diff.js';

test('lineDiff: keeps common lines, marks the rest', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc'), [
    { kind: 'same', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'x' },
    { kind: 'same', text: 'c' },
  ]);
  assert.equal(changed(lineDiff('a\nb', 'a\nb')), 0);
  assert.deepEqual(lineDiff('', 'new'), [{ kind: 'add', text: 'new' }]);
  assert.deepEqual(lineDiff('old', ''), [{ kind: 'del', text: 'old' }]);
});

test('lineDiff: a huge pair does not build a huge table', () => {
  const big = Array.from({ length: 3000 }, (_unused, i) => `l${i}`).join('\n');
  const other = Array.from({ length: 3000 }, (_unused, i) => `m${i}`).join('\n');
  const diff = lineDiff(big, other);
  assert.equal(diff.length, 6000);
});
