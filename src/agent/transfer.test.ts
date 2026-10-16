import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpUrl } from './transfer.js';

test('httpUrl turns the worker URL into the one the SIP API speaks', () => {
  assert.equal(httpUrl('ws://127.0.0.1:7880'), 'http://127.0.0.1:7880');
  assert.equal(httpUrl('wss://example.livekit.cloud'), 'https://example.livekit.cloud');
});

test('httpUrl leaves an HTTP URL and a host that starts with ws alone', () => {
  assert.equal(httpUrl('https://example.livekit.cloud'), 'https://example.livekit.cloud');
  assert.equal(httpUrl('http://ws.example'), 'http://ws.example');
});
