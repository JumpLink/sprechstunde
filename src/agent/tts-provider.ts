import { type tts } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as mistral from '@livekit/agents-plugin-mistralai';
import * as openai from '@livekit/agents-plugin-openai';
import type { Mistral } from '@mistralai/mistralai';
import type { Profile } from '../core/profile.js';
import { spellOutNumbers } from '../core/spoken-numbers.js';
import { _ } from '../i18n.js';
import { DEFAULT_POCKET_URL, PocketTTS } from './pocket-tts.js';
import { resolveTtsVoice } from './tts-voice.js';

const PROVIDERS = ['mistral', 'cartesia', 'openrouter', 'pocket'] as const;
export type TtsProvider = (typeof PROVIDERS)[number];

const DEFAULT_MODEL: Record<TtsProvider, string | undefined> = {
  mistral: 'voxtral-mini-tts-latest',
  cartesia: 'sonic-3.6',
  // OpenRouter routes to many vendors; there is no sensible default.
  openrouter: undefined,
  // Our own server runs one model; the name only shows up in the metrics.
  pocket: 'pocket-tts',
};

const PRIMARY = 'SPRECHSTUNDE_TTS_';
const FALLBACK = 'SPRECHSTUNDE_TTS_FALLBACK_';

export type TtsChoice = {
  provider: TtsProvider;
  model: string;
  voice?: string;
  /** The name the assistant gives itself while it speaks with this voice; the profile's otherwise. */
  name?: string;
  /** Env prefix this choice was read from, so the vendor's own settings are read from it too. */
  prefix: string;
};

/**
 * `SPRECHSTUNDE_TTS_PROVIDER` picks the vendor (default `mistral`). A voice id belongs to one
 * vendor, so for Cartesia and OpenRouter `SPRECHSTUNDE_TTS_VOICE` is required and the profile's
 * voice is ignored; Pocket falls back to its server's default voice. `prefix` reads the same keys
 * for the fallback voice (`SPRECHSTUNDE_TTS_FALLBACK_…`).
 */
export function ttsChoice(env: NodeJS.ProcessEnv = process.env, prefix = PRIMARY): TtsChoice {
  const key = (name: string) => `${prefix}${name}`;
  const provider = (env[key('PROVIDER')] || 'mistral') as TtsProvider;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(_('%1 must be one of: %2').replace('%1', key('PROVIDER')).replace('%2', PROVIDERS.join(', ')));
  }
  const model = env[key('MODEL')] || DEFAULT_MODEL[provider];
  if (!model) throw new Error(_('%s must be set').replace('%s', key('MODEL')));
  const voice = env[key('VOICE')] || undefined;
  if ((provider === 'cartesia' || provider === 'openrouter') && !voice) {
    throw new Error(_('%s must be set').replace('%s', key('VOICE')));
  }
  return { provider, model, voice, name: env[key('NAME')] || undefined, prefix };
}

/** The voice used when the primary one has no room for a call or fails; none unless configured. */
export function ttsFallbackChoice(env: NodeJS.ProcessEnv = process.env): TtsChoice | undefined {
  if (!env[`${FALLBACK}PROVIDER`]) return undefined;
  return ttsChoice(env, FALLBACK);
}

export function pocketUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.POCKET_TTS_URL || DEFAULT_POCKET_URL).replace(/\/+$/, '');
}

export function buildBaseTts(
  client: Mistral,
  profile: Profile,
  choice: TtsChoice,
  env: NodeJS.ProcessEnv = process.env,
): tts.TTS {
  const { provider, model, voice, prefix } = choice;
  switch (provider) {
    case 'mistral':
      return new mistral.TTS({
        client,
        model,
        ...resolveTtsVoice(profile, {
          SPRECHSTUNDE_TTS_VOICE: env[`${prefix}VOICE`],
          SPRECHSTUNDE_TTS_REF_AUDIO: env[`${prefix}REF_AUDIO`],
        }),
      });
    case 'cartesia':
      return new cartesia.TTS({ model, voice: voice!, language: profile.locale.split('-')[0]! });
    case 'openrouter': {
      const apiKey = env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error(_('%s must be set').replace('%s', 'OPENROUTER_API_KEY'));
      // OpenAI-compatible /audio/speech; the plugin asks for 24 kHz PCM.
      return new openai.TTS({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
        model,
        voice: voice as openai.TTSVoices,
      });
    }
    case 'pocket':
      return new PocketTTS(pocketUrl(env), voice, spellOutNumbers(profile.locale));
  }
}
