import { llm } from '@livekit/agents';
import * as mistral from '@livekit/agents-plugin-mistralai';
import type { Mistral } from '@mistralai/mistralai';
import type { Settings } from '../core/settings.js';

export const DEFAULT_LLM_MODEL = 'mistral-small-latest';
// A reply the caller waits for: three seconds of silence is already long on the phone, and the
// second model needs its own time on top. Mistral's own answers start after ~0.5 s (README).
const DEFAULT_ATTEMPT_TIMEOUT_S = 3;

/** The model for this call: the settings file first, then the environment, then the default. */
export function llmModel(settings?: Settings, env: NodeJS.ProcessEnv = process.env): string {
  return settings?.llm.model || env.SPRECHSTUNDE_LLM_MODEL || DEFAULT_LLM_MODEL;
}

/** The second model, asked when the first is too slow or fails; none unless one is configured. */
export function llmFallbackModel(settings?: Settings, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return settings?.llm.fallbackModel || env.SPRECHSTUNDE_LLM_FALLBACK_MODEL || undefined;
}

function attemptTimeoutS(settings?: Settings, env: NodeJS.ProcessEnv = process.env): number {
  if (settings?.llm.attemptTimeoutS) return settings.llm.attemptTimeoutS;
  const fromEnv = Number(env.SPRECHSTUNDE_LLM_ATTEMPT_TIMEOUT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_ATTEMPT_TIMEOUT_S;
}

/**
 * The LLM for a call. With a second model configured it goes behind a `llm.FallbackAdapter`: on
 * 2026-10-19 Mistral answered single requests only after 10 s and with 503s in the middle of a
 * call, which leaves the caller in silence. The adapter's `attemptTimeout` is in *seconds*; it
 * bounds one model's attempt, not the whole reply.
 *
 * Without a second model the single LLM stays, so nothing changes for a default install.
 */
export function buildLlm(client: Mistral, settings?: Settings, env: NodeJS.ProcessEnv = process.env): llm.LLM {
  const model = llmModel(settings, env);
  const fallback = llmFallbackModel(settings, env);
  const primary = new mistral.LLM({ client, model });
  // The same model twice would only ask the service that just timed out a second time.
  if (!fallback || fallback === model) return primary;
  return new llm.FallbackAdapter({
    llms: [primary, new mistral.LLM({ client, model: fallback })],
    attemptTimeout: attemptTimeoutS(settings, env),
  });
}
