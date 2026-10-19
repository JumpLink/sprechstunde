import type { tts } from '@livekit/agents';
import { _ } from '../i18n.js';

/**
 * End of a call: close the call's TTS and give back what it reserved. `speech.tts` is the outermost
 * object (a `tts.FallbackAdapter` closes its children itself), so it is closed exactly once. A
 * failure here must not keep the job from shutting down.
 */
export async function closeSpeech(speech: { tts: tts.TTS; release?: () => Promise<void> }): Promise<void> {
  await speech.release?.();
  await speech.tts.close().catch((error) => console.error(_('Closing the TTS failed'), error));
}
