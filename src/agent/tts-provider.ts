import { type tts } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as mistral from '@livekit/agents-plugin-mistralai';
import * as openai from '@livekit/agents-plugin-openai';
import type { Mistral } from '@mistralai/mistralai';
import { SUPPORTED_LANGUAGES, TTS as KugelTTS } from 'kugelaudio/livekit';
import type { Profile } from '../core/profile.js';
import { activePreset, KUGEL_VOICE_ID, presetRefAudioPath, type Settings, type VoicePreset } from '../core/settings.js';
import { spellOutNumbers } from '../core/spoken-numbers.js';
import { _ } from '../i18n.js';
import { DEFAULT_POCKET_URL, PocketTTS } from './pocket-tts.js';
import { resolveTtsVoice } from './tts-voice.js';

const PROVIDERS = ['mistral', 'cartesia', 'openrouter', 'pocket', 'kugel'] as const;
export type TtsProvider = (typeof PROVIDERS)[number];

const DEFAULT_MODEL: Record<TtsProvider, string | undefined> = {
  mistral: 'voxtral-mini-tts-latest',
  cartesia: 'sonic-3.6',
  // OpenRouter routes to many vendors; there is no sensible default.
  openrouter: undefined,
  // Our own server runs one model; the name only shows up in the metrics.
  pocket: 'pocket-tts',
  // Not in the SDK's `TTSModels` type, but the API accepted it in a real call on 2026-10-19.
  kugel: 'kugel-3.5',
};

/** The model a vendor's provider uses when none is named; none for OpenRouter. */
export function defaultTtsModel(provider: TtsProvider): string | undefined {
  return DEFAULT_MODEL[provider];
}

/** Vendors whose voice ids are their own, so the profile's voice means nothing to them. */
const NEEDS_OWN_VOICE: readonly TtsProvider[] = ['cartesia', 'openrouter', 'kugel'];

const PRIMARY = 'SPRECHSTUNDE_TTS_';
const FALLBACK = 'SPRECHSTUNDE_TTS_FALLBACK_';

/** Region prefixes KugelAudio reads off the API key to pick an endpoint. */
const KUGEL_KEY_PREFIXES = ['eu-', 'us-', 'global-'];
const KUGEL_REGIONS = ['eu', 'global'] as const;

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
 * vendor, so for Cartesia, OpenRouter and Kugel `SPRECHSTUNDE_TTS_VOICE` is required and the
 * profile's voice is ignored; Pocket falls back to its server's default voice. `prefix` reads the
 * same keys for the fallback voice (`SPRECHSTUNDE_TTS_FALLBACK_…`).
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
  if (NEEDS_OWN_VOICE.includes(provider) && !voice) {
    throw new Error(_('%s must be set').replace('%s', key('VOICE')));
  }
  if (provider === 'kugel' && !isKugelVoiceId(voice)) {
    throw new Error(_('%s must be a numeric KugelAudio voice id').replace('%s', key('VOICE')));
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
  if (preset.provider === 'kugel' && !isKugelVoiceId(preset.voice)) {
    throw new Error(_('preset "%s" needs a numeric KugelAudio voice id').replace('%s', preset.id));
  }
  return {
    provider: preset.provider,
    model,
    voice: preset.voice,
    refAudio: preset.refAudio && (presetRefAudioPath(preset.refAudio) ?? undefined),
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

/** KugelAudio names its voices by number; a name or another vendor's id is not one. */
export function isKugelVoiceId(voice: string | undefined): voice is string {
  return voice !== undefined && KUGEL_VOICE_ID.test(voice);
}

/**
 * The KugelAudio key with the region it should be used in. The vendor reads the region off a
 * prefix on the key (`eu-`, stripped before auth) and routes a bare key through its global
 * endpoint, so the default here is `eu-`: a German phone line has no reason to send what a caller
 * says outside the EU. `SPRECHSTUNDE_KUGEL_REGION=global` opts out; a key that already names a
 * region keeps it, because that was written down on purpose.
 */
export function kugelApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.KUGELAUDIO_API_KEY;
  if (!key) throw new Error(_('%s must be set').replace('%s', 'KUGELAUDIO_API_KEY'));
  const region = env.SPRECHSTUNDE_KUGEL_REGION || 'eu';
  if (!(KUGEL_REGIONS as readonly string[]).includes(region)) {
    throw new Error(
      _('%1 must be one of: %2').replace('%1', 'SPRECHSTUNDE_KUGEL_REGION').replace('%2', KUGEL_REGIONS.join(', ')),
    );
  }
  if (KUGEL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return key;
  return `${region}-${key}`;
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
    case 'kugel': {
      const language = profile.locale.split('-')[0]!;
      return new KugelTTS({
        apiKey: kugelApiKey(env),
        model,
        // Every path that builds a choice has checked this is a number (`ttsChoice`,
        // `choiceFromPreset`, `parsePreset`); an unchecked value would reach the vendor as "no
        // voice" and be answered in its default one.
        voiceId: Number(voice),
        // With a language the vendor normalizes numbers, times and dates itself, so the spell-out
        // Pocket needs stays out of this path. An unsupported code makes the constructor throw, and
        // the voice's own language is a better answer than a failed call.
        ...(SUPPORTED_LANGUAGES.has(language) && { language }),
        // The default sample rate (24 kHz) is what the model generates natively; the other rates
        // are server-side resampling. Asking for 8 kHz would only move the phone-line downsampling
        // to the vendor, and the agent mixes at 24 kHz either way.
      });
    }
  }
}
