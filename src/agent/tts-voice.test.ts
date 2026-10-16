import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Profile } from '../core/profile.js';
import { refAudioFromFile, resolveTtsVoice } from './tts-voice.js';

const dir = mkdtempSync(join(tmpdir(), 'sprechstunde-tts-'));
const clip = join(dir, 'clip.wav');
const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x10]);
writeFileSync(clip, bytes);
const empty = join(dir, 'empty.wav');
writeFileSync(empty, '');

function profile(voice?: Profile['voice']): Profile {
  return { id: 'p', locale: 'de-DE', timeZone: 'Europe/Berlin', assistantName: 'A', greeting: 'g', instructions: 'i', facts: [], voice };
}

test('refAudioFromFile returns plain base64 of the file', () => {
  const encoded = refAudioFromFile(clip);
  assert.equal(encoded, bytes.toString('base64'));
  assert.doesNotMatch(encoded, /^data:/);
});

test('refAudioFromFile rejects a missing or empty file', () => {
  assert.throws(() => refAudioFromFile(join(dir, 'nope.wav')), /Cannot read reference audio/);
  assert.throws(() => refAudioFromFile(empty), /empty/);
});

test('the env reference audio beats everything else', () => {
  const result = resolveTtsVoice(profile({ ttsVoice: 'x' }), {
    SPRECHSTUNDE_TTS_REF_AUDIO: clip,
    SPRECHSTUNDE_TTS_VOICE: 'y',
  });
  assert.deepEqual(result, { refAudio: bytes.toString('base64') });
});

test('the env voice beats the profile', () => {
  assert.deepEqual(resolveTtsVoice(profile({ refAudio: clip }), { SPRECHSTUNDE_TTS_VOICE: 'y' }), { voice: 'y' });
});

test('the profile reference audio is used, else its voice, else the plugin default', () => {
  assert.deepEqual(resolveTtsVoice(profile({ refAudio: clip }), {}), { refAudio: bytes.toString('base64') });
  assert.deepEqual(resolveTtsVoice(profile({ ttsVoice: 'fr_marie_neutral' }), {}), { voice: 'fr_marie_neutral' });
  assert.deepEqual(resolveTtsVoice(profile(), {}), { voice: undefined });
});
