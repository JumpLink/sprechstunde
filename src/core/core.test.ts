import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProfile, parseProfile } from './profile.js';
import { buildInstructions } from './prompt.js';

const example = loadProfile('profiles/example/profile.de.json');

function variant(change: (raw: Record<string, unknown>) => void): unknown {
  const raw = JSON.parse(JSON.stringify(example)) as Record<string, unknown>;
  change(raw);
  return raw;
}

test('example profile is valid', () => {
  assert.equal(example.locale, 'de-DE');
  assert.ok(example.facts.length >= 8);
  assert.match(example.greeting, /KI/);
});

test('rejects an empty greeting', () => {
  assert.throws(() => parseProfile(variant((r) => (r.greeting = '  '))), /greeting/);
});

test('rejects a bad locale', () => {
  assert.throws(() => parseProfile(variant((r) => (r.locale = 'not a tag'))), /locale/);
});

test('rejects a transfer target that is neither tel: nor sip:', () => {
  assert.throws(
    () => parseProfile(variant((r) => (r.transfer = { target: 'http://x', announce: 'a' }))),
    /transfer\.target/,
  );
});

test('rejects a fact without an answer', () => {
  assert.throws(() => parseProfile(variant((r) => (r.facts = [{ topic: 'x' }]))), /facts\[0\]/);
});

test('rejects an unknown time zone', () => {
  assert.throws(() => parseProfile(variant((r) => (r.timeZone = 'Mars/Olympus'))), /timeZone/);
});

test('instructions contain every fact and the assistant name', () => {
  const text = buildInstructions(example, new Date());
  for (const fact of example.facts) assert.ok(text.includes(fact.answer));
  assert.ok(text.includes(example.assistantName));
});

test('instructions list the facts inline and do not send the model to a tool', () => {
  const text = buildInstructions(example, new Date());
  for (const fact of example.facts) assert.ok(text.includes(`- ${fact.topic}: ${fact.answer}`));
  assert.ok(!text.includes('lookup_fact'));
});

test('instructions state the local date and weekday of the venue', () => {
  // 23:30 UTC on a Saturday is already Sunday in Berlin.
  const text = buildInstructions(example, new Date('2026-10-17T23:30:00Z'));
  assert.match(text, /Sonntag, 18\. Oktober 2026 um 01:30/);
});

test('rejects ttsVoice together with refAudio', () => {
  assert.throws(
    () => parseProfile(variant((r) => (r.voice = { ttsVoice: 'a', refAudio: 'b.wav' }))),
    /mutually exclusive/,
  );
});

test('rejects a non-string or empty refAudio', () => {
  assert.throws(() => parseProfile(variant((r) => (r.voice = { refAudio: 3 }))), /refAudio/);
  assert.throws(() => parseProfile(variant((r) => (r.voice = { refAudio: ' ' }))), /refAudio/);
});

test('accepts refAudio alone', () => {
  const profile = parseProfile(variant((r) => (r.voice = { refAudio: 'voice.wav' })));
  assert.deepEqual(profile.voice, { refAudio: 'voice.wav' });
});

test('loadProfile resolves refAudio against the profile file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprechstunde-profile-'));
  const file = join(dir, 'profile.json');
  writeFileSync(file, JSON.stringify({ ...example, voice: { refAudio: 'sub/voice.wav' } }));
  assert.equal(loadProfile(file).voice?.refAudio, join(dir, 'sub', 'voice.wav'));
});
