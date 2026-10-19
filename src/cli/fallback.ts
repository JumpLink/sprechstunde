import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveTtsVoice } from '../agent/tts-voice.js';
import { downsampleS16le, encodeWav } from '../core/audio.js';
import { loadProfile } from '../core/profile.js';
import { _ } from '../i18n.js';
import { mistralClient } from '../mistral.js';
import { synthesize } from './speech.js';

const SAMPLE_RATE = 24000;
const PHONE_FACTOR = 3; // 24 kHz -> 8 kHz, what Asterisk plays a .wav at without transcoding
// compose.yaml mounts this directory into the Asterisk container; extensions.conf plays the file
// when it exists and Asterisk's own English prompt otherwise.
const DEFAULT_OUT = 'deploy/asterisk/sounds/fallback.wav';
const DEFAULT_MODEL = 'voxtral-mini-tts-latest';

/** Record the profile's `fallback` text for the gateway to play when no agent answers. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, text: { type: 'string' } } });

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error(_('%s must be set').replace('%s', 'MISTRAL_API_KEY'));

  const profile = loadProfile();
  const text = values.text ?? profile.fallback;
  if (!text) throw new Error(_('the profile has no "fallback" text; add one or pass --text'));

  const { pcm } = await synthesize(
    mistralClient(apiKey),
    process.env.SPRECHSTUNDE_TTS_MODEL || DEFAULT_MODEL,
    text,
    resolveTtsVoice(profile),
  );
  const out = values.out ?? DEFAULT_OUT;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodeWav(SAMPLE_RATE / PHONE_FACTOR, downsampleS16le(pcm, PHONE_FACTOR)));
  console.log(_('fallback announcement written to'), out);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
