import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactLine, redactPiiLogs } from './redact-logs.js';

test('redactLine: lk.pii.* keys go, every other key stays', () => {
  const line = JSON.stringify({
    level: 30,
    msg: 'user transcript',
    'lk.pii.user_transcript': 'x',
    'lk.pii.message': 'y',
    room: 'r',
    n: 1,
  });
  const out = JSON.parse(redactLine(line + '\n'));
  assert.deepEqual(out, { level: 30, msg: 'user transcript', room: 'r', n: 1 });
});

test('redactLine: other lines pass through unchanged', () => {
  for (const line of ['plain text lk.pii.x', '{broken lk.pii.', '[1,"lk.pii."]', '{"a":1}\n', '']) {
    assert.equal(redactLine(line), line);
  }
});

test('redactPiiLogs: wraps write once, for strings and buffers, other chunks pass', () => {
  const seen: unknown[] = [];
  const stream = { write: (chunk: unknown) => (seen.push(chunk), true) };
  redactPiiLogs(stream);
  const wrapped = stream.write;
  redactPiiLogs(stream);
  assert.equal(stream.write, wrapped);
  const line = '{"a":1,"lk.pii.x":"secret"}\n';
  stream.write(line);
  stream.write(Buffer.from(line));
  stream.write('not json\n');
  assert.deepEqual(
    seen.map((s) => String(s)),
    ['{"a":1}\n', '{"a":1}\n', 'not json\n'],
  );
});
