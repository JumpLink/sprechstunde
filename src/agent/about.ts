import { type Builder, type Technology } from '../core/about.js';
import { type Character, type Settings } from '../core/settings.js';
import { llmFallbackModel, llmModel } from './llm.js';
import { FALLBACK_STT_MODEL, sttModel } from './stt-models.js';
import { ttsChoices } from './tts-provider.js';

/** The models a call with this character runs, read from the same places the agent reads them. */
export function technologyFor(
  settings: Settings | undefined,
  character: Character | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Technology {
  const { primary, fallback } = ttsChoices(character, env);
  return {
    llm: { model: llmModel(settings, env), fallback: llmFallbackModel(settings, env) },
    stt: { model: sttModel(env), fallback: FALLBACK_STT_MODEL },
    tts: [primary, ...(fallback ? [fallback] : [])].map(({ provider, model }) => ({ provider, model })),
  };
}

/** Set by the operator in the environment, so the public code names nobody; none without a name. */
export function builderFromEnv(env: NodeJS.ProcessEnv = process.env): Builder | undefined {
  const name = env.SPRECHSTUNDE_BUILDER_NAME?.trim();
  if (!name) return undefined;
  return {
    name,
    ...(env.SPRECHSTUNDE_BUILDER_PLACE?.trim() && { place: env.SPRECHSTUNDE_BUILDER_PLACE.trim() }),
    ...(env.SPRECHSTUNDE_BUILDER_EMAIL?.trim() && { email: env.SPRECHSTUNDE_BUILDER_EMAIL.trim() }),
    ...(env.SPRECHSTUNDE_BUILDER_URL?.trim() && { url: env.SPRECHSTUNDE_BUILDER_URL.trim() }),
  };
}
