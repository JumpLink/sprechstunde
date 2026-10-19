import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { tts } from '@livekit/agents';
import { closeSpeech } from './speech-close.js';

const fake = (close: () => Promise<void>) => ({ close }) as unknown as tts.TTS;

test('closeSpeech: releases and closes the TTS once', async () => {
  const calls: string[] = [];
  await closeSpeech({
    tts: fake(async () => void calls.push('close')),
    release: async () => void calls.push('release'),
  });
  assert.deepEqual(calls, ['release', 'close']);
});

test('closeSpeech: a failing close does not throw', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    await closeSpeech({
      tts: fake(async () => {
        throw new Error('boom');
      }),
    });
  } finally {
    console.error = original;
  }
});
