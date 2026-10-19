import { type tts } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as mistral from '@livekit/agents-plugin-mistralai';
import * as openai from '@livekit/agents-plugin-openai';
import type { Mistral } from '@mistralai/mistralai';
import type { Profile } from '../core/profile.js';
import { _ } from '../i18n.js';
import { resolveTtsVoice } from './tts-voice.js';

const PROVIDERS = ['mistral', 'cartesia', 'openrouter'] as const;
export type TtsProvider = (typeof PROVIDERS)[number];

const DEFAULT_MODEL: Record<TtsProvider, string | undefined> = {
  mistral: 'voxtral-mini-tts-latest',
  cartesia: 'sonic-3.6',
  // OpenRouter routes to many vendors; there is no sensible default.
  openrouter: undefined,
};

export type TtsChoice = { provider: TtsProvider; model: string; voice?: string };

/**
 * `SPRECHSTUNDE_TTS_PROVIDER` picks the vendor (default `mistral`). A voice id belongs to one
 * vendor, so for any other than Mistral `SPRECHSTUNDE_TTS_VOICE` is required and the profile's
 * voice is ignored.
 */
export function ttsChoice(env: NodeJS.ProcessEnv = process.env): TtsChoice {
  const provider = (env.SPRECHSTUNDE_TTS_PROVIDER || 'mistral') as TtsProvider;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(_('SPRECHSTUNDE_TTS_PROVIDER must be one of: %s').replace('%s', PROVIDERS.join(', ')));
  }
  const model = env.SPRECHSTUNDE_TTS_MODEL || DEFAULT_MODEL[provider];
  if (!model) throw new Error(_('%s must be set').replace('%s', 'SPRECHSTUNDE_TTS_MODEL'));
  const voice = env.SPRECHSTUNDE_TTS_VOICE || undefined;
  if (provider !== 'mistral' && !voice) throw new Error(_('%s must be set').replace('%s', 'SPRECHSTUNDE_TTS_VOICE'));
  return { provider, model, voice };
}

export function buildBaseTts(client: Mistral, profile: Profile, env: NodeJS.ProcessEnv = process.env): tts.TTS {
  const { provider, model, voice } = ttsChoice(env);
  switch (provider) {
    case 'mistral':
      return new mistral.TTS({ client, model, ...resolveTtsVoice(profile, env) });
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
  }
}
