export const DEFAULT_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
export const FALLBACK_STT_MODEL = 'voxtral-mini-latest';

export function sttModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPRECHSTUNDE_STT_MODEL || DEFAULT_STT_MODEL;
}
