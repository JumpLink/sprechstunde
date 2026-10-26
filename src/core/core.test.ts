import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProfile, parseProfile, withAssistantName } from './profile.js';
import { buildInstructions, personaOf } from './prompt.js';
import { describeKnowledge } from './knowledge.js';
import { maskTransferTarget, TRANSFER_TOOL, toolDescriptors, transferOverride, transferRequest } from './tools.js';

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

test('an empty path means the default profile', () => {
  // The admin passes the variable through as a path argument; compose sets an unset one to "".
  assert.equal(loadProfile('').id, loadProfile().id);
});

test('an empty SPRECHSTUNDE_PROFILE means the default profile', () => {
  const saved = process.env.SPRECHSTUNDE_PROFILE;
  process.env.SPRECHSTUNDE_PROFILE = '';
  try {
    assert.equal(loadProfile().id, example.id);
  } finally {
    if (saved === undefined) delete process.env.SPRECHSTUNDE_PROFILE;
    else process.env.SPRECHSTUNDE_PROFILE = saved;
  }
});

test('fallback is optional and must not be empty', () => {
  assert.equal(parseProfile(variant((r) => delete r.fallback)).fallback, undefined);
  assert.throws(() => parseProfile(variant((r) => (r.fallback = ' '))), /fallback/);
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

const NOW = new Date('2026-10-17T12:00:00Z');

test('prompt: without a persona, or with an empty one, it is exactly what it was', () => {
  const plain = buildInstructions(example, NOW);
  assert.equal(buildInstructions(example, NOW, undefined), plain);
  assert.equal(buildInstructions(example, NOW, {}), plain);
  assert.equal(buildInstructions(example, NOW, { tone: '' }), plain);
  assert.doesNotMatch(plain, /Speaking style/);
});

test('prompt: a migrated character of unknown gender changes nothing', () => {
  const plain = buildInstructions(example, NOW);
  const migrated = {
    gender: 'neutral',
    genderUnknown: true,
    tone: undefined,
  } as const;
  assert.equal(buildInstructions(example, NOW, personaOf(migrated)), plain);
});

test('prompt: the tone becomes a speaking-style line before the rules', () => {
  const text = buildInstructions(example, NOW, { tone: 'Warm and calm.' });
  assert.match(text, /^Speaking style: Warm and calm\.$/m);
  assert.ok(text.indexOf('Speaking style') < text.indexOf('Rules:'));
});

test('prompt: gender picks the German self-description', () => {
  assert.equal(example.locale.startsWith('de'), true);
  assert.match(buildInstructions(example, NOW, { gender: 'female' }), /"eine KI-Assistentin"/);
  assert.match(buildInstructions(example, NOW, { gender: 'male' }), /"ein KI-Assistent"/);
  assert.match(buildInstructions(example, NOW, { gender: 'neutral' }), /"eine KI"/);
});

test('prompt: gender wording stays out of a venue that does not speak German', () => {
  const english = { ...example, locale: 'en-GB' };
  const text = buildInstructions(english, NOW, { gender: 'female' });
  assert.doesNotMatch(text, /KI/);
  assert.match(text, /feminine/);
});

test('prompt: a venue greeting is never rewritten by the persona', () => {
  const persona = { tone: 'Cheerful.', gender: 'female' } as const;
  const text = buildInstructions(example, NOW, persona);
  assert.equal(describeKnowledge(example, NOW, undefined, persona).greeting, example.greeting);
  assert.ok(text.includes(example.instructions));
});

test('profile: the character is an optional id', () => {
  assert.equal(parseProfile(variant(() => {})).character, undefined);
  assert.equal(parseProfile(variant((r) => (r.character = 'mia'))).character, 'mia');
  assert.throws(() => parseProfile(variant((r) => (r.character = 'not an id'))), /"character"/);
  assert.throws(() => parseProfile(variant((r) => (r.character = 5))), /character/);
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

test('transferRequest: a configured number replaces the profile target', () => {
  const profile = loadProfile();
  assert.equal(transferRequest(profile)?.target, profile.transfer?.target);
  assert.equal(transferRequest(profile, { number: '+4930123' })?.target, 'tel:+4930123');
  assert.equal(
    transferRequest(profile, { number: '+4930123', sipHost: '127.0.0.1:5070' })?.target,
    'sip:+4930123@127.0.0.1:5070',
  );
  assert.equal(transferRequest(profile, { sipHost: 'x' })?.target, profile.transfer?.target);
  assert.equal(transferRequest(profile, { number: '+4930123' })?.announce, profile.transfer?.announce);
  assert.throws(() => transferRequest(profile, { number: 'sip:x@y' }));
  assert.equal(transferRequest({ ...profile, transfer: undefined }, { number: '+4930123' }), null);
});

test('withAssistantName renames whole-word mentions only', () => {
  const profile = {
    ...example,
    assistantName: 'Mia',
    greeting: 'Sie sprechen mit Mia. Miami? Mia!',
  };
  const renamed = withAssistantName(profile, 'Jürgen');
  assert.equal(renamed.assistantName, 'Jürgen');
  assert.equal(renamed.greeting, 'Sie sprechen mit Jürgen. Miami? Jürgen!');
  assert.equal(withAssistantName(profile, undefined), profile);
});

test('the tool descriptors are what the prompt and the agent refer to', () => {
  const tools = toolDescriptors();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [TRANSFER_TOOL.name],
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.parameters.type, 'object');
    assert.ok(tool.availableWhen.length > 0);
  }
  assert.ok(buildInstructions(example, new Date()).includes(TRANSFER_TOOL.name));
});

test('transferOverride reads the deployment, with a default SIP host', () => {
  assert.deepEqual(transferOverride({}), {
    number: undefined,
    sipHost: '127.0.0.1:5070',
  });
  assert.deepEqual(
    transferOverride({
      TRANSFER_TARGET_NUMBER: '+491',
      TRANSFER_SIP_HOST: 'pbx:5060',
    }),
    {
      number: '+491',
      sipHost: 'pbx:5060',
    },
  );
});

test('maskTransferTarget keeps the scheme and the last two digits only', () => {
  assert.equal(maskTransferTarget('tel:+4930123456'), 'tel:+••••••••56');
  assert.equal(maskTransferTarget('sip:+4930123456@10.0.0.1:5070'), 'sip:+••••••••56');
  assert.equal(maskTransferTarget('tel:7'), 'tel:7');
  assert.equal(maskTransferTarget('garbage'), '•••');
});

test('describeKnowledge masks the transfer target and uses the real prompt', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  const knowledge = describeKnowledge(example, now);
  assert.equal(knowledge.systemPrompt, buildInstructions(example, now));
  assert.equal(knowledge.facts.length, example.facts.length);
  assert.equal(knowledge.transfer?.announce, example.transfer?.announce);
  assert.doesNotMatch(JSON.stringify(knowledge), /\+4900000000/);
  assert.match(knowledge.transfer?.targetMasked ?? '', /^tel:\+•+00$/);

  const override = describeKnowledge(example, now, {
    number: '+4915112345678',
    sipHost: 'pbx:5060',
  });
  assert.equal(override.transfer?.targetMasked, 'sip:+•••••••••••78');
  assert.doesNotMatch(JSON.stringify(override), /12345678|pbx/);

  const { transfer: _transfer, ...withoutTransfer } = example;
  assert.equal(describeKnowledge(withoutTransfer, now).transfer, null);
});

test('prompt: the allergen rule is always there, with and without reference data', () => {
  for (const text of [
    buildInstructions(example, NOW),
    buildInstructions(example, NOW, undefined, 'Soup: contains celery'),
  ]) {
    assert.match(text, /allergens, ingredients and diets, only repeat what the facts or reference data state/);
    assert.match(text, /Never say a dish is guaranteed free of anything/);
    assert.match(text, /say you do not know and offer a person/);
  }
  // the rule sits in the fixed rules, above the facts and the untrusted reference block
  const text = buildInstructions(example, NOW, undefined, 'Soup: contains celery');
  assert.ok(text.indexOf('allergens') < text.indexOf('Facts:'));
  assert.ok(text.indexOf('allergens') < text.indexOf('<reference-data>'));
});

test('selfDescription: trimmed, empty means absent, only a string is accepted', () => {
  assert.equal(
    parseProfile(variant((r) => (r.selfDescription = '  ein digitaler Helfer '))).selfDescription,
    'ein digitaler Helfer',
  );
  assert.equal(parseProfile(variant((r) => (r.selfDescription = '  '))).selfDescription, undefined);
  assert.equal(parseProfile(variant((r) => delete r.selfDescription)).selfDescription, undefined);
  assert.throws(() => parseProfile(variant((r) => (r.selfDescription = 5))), /selfDescription/);
});

test('selfDescription: replaces the built-in wording, with or without a gender, in any locale', () => {
  const base = parseProfile(variant(() => {}));
  const own = { ...base, selfDescription: 'ein digitaler Helfer' };
  const line = 'If you say what you are, say "ein digitaler Helfer".';
  assert.ok(buildInstructions(own, NOW, { gender: 'male' }).includes(line));
  assert.ok(!buildInstructions(own, NOW, { gender: 'male' }).includes('KI-Assistent'));
  assert.ok(buildInstructions(own, NOW).includes(line));
  assert.ok(buildInstructions({ ...own, locale: 'en-GB' }, NOW, { gender: 'female' }).includes(line));
  assert.ok(buildInstructions(base, NOW, { gender: 'male' }).includes('"ein KI-Assistent"'));
  assert.ok(!buildInstructions(base, NOW).includes('If you say what you are'));
});
