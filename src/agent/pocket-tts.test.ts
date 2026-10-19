import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { initializeLogger } from '@livekit/agents';
import { openPocketSession, POCKET_SAMPLE_RATE, PocketTTS } from './pocket-tts.js';

initializeLogger({ pretty: false, level: 'fatal' });

/** A stand-in for `deploy/pocket-tts/server.py` on a random local port. */
async function fakeServer(
  handle: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => handle(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test('PocketTTS streams the PCM answer as frames and spells out the text first', async () => {
  let sent: { text: string; voice?: string } | undefined;
  const { url, server } = await fakeServer((_req, body, res) => {
    sent = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'audio/pcm' });
    // 0.1 s of silence in two chunks, split mid-sample on purpose.
    const pcm = Buffer.alloc(POCKET_SAMPLE_RATE * 0.1 * 2);
    res.write(pcm.subarray(0, 1001));
    res.end(pcm.subarray(1001));
  });
  try {
    const voice = new PocketTTS(url, 'juergen', (text) => text.replace('4', 'vier'));
    let samples = 0;
    let finals = 0;
    for await (const audio of voice.synthesize('für 4 Personen')) {
      samples += audio.frame.samplesPerChannel;
      if (audio.final) finals++;
    }
    assert.deepEqual(sent, { text: 'für vier Personen', voice: 'juergen' });
    assert.equal(samples, POCKET_SAMPLE_RATE * 0.1);
    assert.equal(finals, 1);
  } finally {
    server.close();
  }
});

test('PocketTTS reports a busy server as an error', async () => {
  const { url, server } = await fakeServer((_req, _body, res) => {
    res.writeHead(503).end('{"error":"no free worker"}');
  });
  try {
    const stream = new PocketTTS(url).synthesize('Hallo.', { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 });
    for await (const _audio of stream) assert.fail('no audio expected');
    assert.match(String(stream.error), /503/);
  } finally {
    server.close();
  }
});

test('openPocketSession: a session to release, or none when all are taken', async () => {
  const deleted: string[] = [];
  let free = 1;
  const { url, server } = await fakeServer((req, _body, res) => {
    if (req.method === 'POST' && free > 0) {
      free--;
      res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"id":"s1"}');
    } else if (req.method === 'POST') {
      res.writeHead(503).end();
    } else {
      deleted.push(req.url ?? '');
      res.writeHead(204).end();
    }
  });
  try {
    const release = await openPocketSession(url);
    assert.ok(release);
    assert.equal(await openPocketSession(url), undefined);
    await release();
    await release();
    assert.deepEqual(deleted, ['/sessions/s1']);
  } finally {
    server.close();
  }
});

test('openPocketSession: an unreachable server means no session', async () => {
  assert.equal(await openPocketSession('http://127.0.0.1:9', 200), undefined);
});
