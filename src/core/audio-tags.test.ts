import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIO_TAGS,
  AudioTagRewriter,
  audioTagLines,
  renderAudioTag,
  rewriteAudioTags,
  stripAudioTags,
} from './audio-tags.js';

function streamed(...pieces: string[]): string {
  const stripper = new AudioTagRewriter();
  return pieces.map((piece) => stripper.push(piece)).join('') + stripper.flush();
}

test('stripAudioTags: the tag and the space after it go, the sentence stays', () => {
  assert.equal(stripAudioTags('[chuckles] Das sagen alle.'), 'Das sagen alle.');
  assert.equal(stripAudioTags('Na gut. [sighs] Leider voll.'), 'Na gut. Leider voll.');
  assert.equal(stripAudioTags('Ohne Tag.'), 'Ohne Tag.');
});

test('AudioTagRewriter: a tag split over pieces never leaks a half', () => {
  const stripper = new AudioTagRewriter();
  assert.equal(stripper.push('Gern. [chuck'), 'Gern. ');
  assert.equal(stripper.push('les] Na'), 'Na');
  assert.equal(stripper.push(' klar.'), ' klar.');
  assert.equal(stripper.flush(), '');
  assert.equal(streamed('[', 'warmly', ']', ' ', 'Willkommen!'), 'Willkommen!');
});

test('AudioTagRewriter: the space after a tag stays when nothing came before it', () => {
  assert.equal(streamed('Ja', '[laughs softly]', ' genau.'), 'Ja genau.');
});

test('AudioTagRewriter: an unclosed bracket is text, released at the end or at a newline', () => {
  assert.equal(streamed('Zimmer [3'), 'Zimmer [3');
  assert.equal(streamed('a [b\nc'), 'a [b\nc');
  const long = `[${'x'.repeat(60)}`;
  assert.equal(streamed(long, ' Ende'), `${long} Ende`);
  assert.equal(streamed('[a [sighs] b'), '[a b');
});

test('audioTagLines: nothing without tags, every tag once with them', () => {
  assert.deepEqual(audioTagLines([]), []);
  const text = audioTagLines(AUDIO_TAGS).join('\n');
  for (const { tag } of AUDIO_TAGS) assert.ok(text.includes(`[${tag}]`));
  assert.match(text, /at most one tag per reply/);
});

test('rewriteAudioTags: Voxtral gets its own cue, unknown cues go, ElevenLabs text passes', () => {
  assert.equal(rewriteAudioTags('[warmly] Bis bald!', 'voxtral'), '[emotion=warm] Bis bald!');
  assert.equal(rewriteAudioTags('Ja [chuckles] genau.', 'voxtral'), 'Ja [chuckle] genau.');
  assert.equal(rewriteAudioTags('Ja [whispers] genau.', 'voxtral'), 'Ja genau.');
  assert.equal(rewriteAudioTags('[sighs] Leider voll.', 'elevenlabs'), '[sighs] Leider voll.');
  assert.equal(rewriteAudioTags('Zimmer [3', 'voxtral'), 'Zimmer [3');
});

test('renderAudioTag: every listed cue has a Voxtral form', () => {
  for (const { tag } of AUDIO_TAGS) assert.match(renderAudioTag('voxtral', tag), /^\[.+\]$/);
});
