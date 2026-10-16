import { readFileSync } from 'node:fs';
import type { Profile } from '../core/profile.js';

export type TtsVoice = { voice?: string; refAudio?: undefined } | { refAudio: string; voice?: undefined };

/**
 * What Mistral's `ref_audio` expects: the audio file itself (mp3 or wav) as plain base64,
 * without a `data:` prefix (docs.mistral.ai/studio/audio/text_to_speech/speech). The SDK type
 * is only `string` (`SpeechRequest.refAudio` in @mistralai/mistralai).
 */
export function refAudioFromFile(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`Cannot read reference audio ${path}: ${(error as Error).message}`);
  }
  if (bytes.byteLength === 0) throw new Error(`Reference audio ${path} is empty`);
  return bytes.toString('base64');
}

/**
 * Pick the TTS voice. Precedence: SPRECHSTUNDE_TTS_REF_AUDIO, SPRECHSTUNDE_TTS_VOICE, then the
 * profile's `refAudio` (already resolved against the profile file), then its `ttsVoice`.
 */
export function resolveTtsVoice(profile: Profile, env: NodeJS.ProcessEnv = process.env): TtsVoice {
  if (env.SPRECHSTUNDE_TTS_REF_AUDIO) return { refAudio: refAudioFromFile(env.SPRECHSTUNDE_TTS_REF_AUDIO) };
  if (env.SPRECHSTUNDE_TTS_VOICE) return { voice: env.SPRECHSTUNDE_TTS_VOICE };
  if (profile.voice?.refAudio) return { refAudio: refAudioFromFile(profile.voice.refAudio) };
  return { voice: profile.voice?.ttsVoice };
}
