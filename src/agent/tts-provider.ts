import { type tts } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as mistral from '@livekit/agents-plugin-mistralai';
import * as openai from '@livekit/agents-plugin-openai';
import type { Mistral } from '@mistralai/mistralai';
import type { Profile } from '../core/profile.js';
import { activePreset, type Settings, type VoicePreset } from '../core/settings.js';
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
  /** Path to an audio file to clone (Mistral only); wins over `voice` and the profile's voice. */
  refAudio?: string;
  /** The name the assistant gives itself while it speaks with this voice; the profile's otherwise. */
  name?: string;
  /** Id of the settings preset this choice came from, or none when the environment decided. */
  preset?: string;
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
  return {
    provider,
    model,
    voice,
    refAudio: env[key('REF_AUDIO')] || undefined,
    name: env[key('NAME')] || undefined,
  };
}

/**
 * The same choice from a settings preset instead of the environment. The preset carries the
 * vendor's own fields, so nothing is read from the environment behind its back — otherwise a
 * `SPRECHSTUNDE_TTS_REF_AUDIO` left over from an earlier test would override every preset voice.
 */
export function choiceFromPreset(preset: VoicePreset): TtsChoice {
  const model = preset.model || DEFAULT_MODEL[preset.provider];
  if (!model) {
    throw new Error(
      _('preset "%1" needs a model for the %2 provider').replace('%1', preset.id).replace('%2', preset.provider),
    );
  }
  return {
    provider: preset.provider,
    model,
    voice: preset.voice,
    refAudio: preset.refAudio,
    name: preset.name,
    preset: preset.id,
  };
}

/**
 * The voice pair for one call. The settings file wins as a whole as soon as it names an active
 * primary preset: mixing a preset with the `SPRECHSTUNDE_TTS_FALLBACK_…` keys would make the
 * second voice depend on which of the two sources was edited last. Without an active primary
 * nothing changes and the environment decides.
 */
export function ttsChoices(
  settings: Settings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { primary: TtsChoice; fallback?: TtsChoice } {
  const primary = activePreset(settings, 'primary');
  if (!primary) return { primary: ttsChoice(env), fallback: ttsFallbackChoice(env) };
  const fallback = activePreset(settings, 'fallback');
  return {
    primary: choiceFromPreset(primary),
    ...(fallback && { fallback: choiceFromPreset(fallback) }),
  };
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
  const { provider, model, voice, refAudio } = choice;
  switch (provider) {
    case 'mistral':
      // The choice carries what the vendor needs; the profile's own voice fills what it leaves open.
      return new mistral.TTS({
        client,
        model,
        ...resolveTtsVoice(profile, { SPRECHSTUNDE_TTS_VOICE: voice, SPRECHSTUNDE_TTS_REF_AUDIO: refAudio }),
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
