import { _ } from './i18n.svelte';
import type { AdminState, Choice, Preset } from './types';

export const describeChoice = (choice: Choice | undefined): string =>
  choice ? [choice.provider, choice.model, choice.voice].filter(Boolean).join(' · ') : '';

/** What a slot (primary or fallback) resolves to: a preset, the environment's voice, or nothing. */
export function resolveSlot(
  state: AdminState,
  slot: 'primary' | 'fallback',
): { label: string; detail: string; preset?: Preset } {
  const id = state.settings.active[slot];
  const preset = id ? state.settings.presets.find((candidate) => candidate.id === id) : undefined;
  if (preset) {
    return {
      label: preset.label,
      detail: [preset.provider, preset.model, preset.voice].filter(Boolean).join(' · '),
      preset,
    };
  }
  const env = state.envVoice[slot];
  if (env) return { label: _('Environment'), detail: describeChoice(env) };
  return { label: _('Not set'), detail: '' };
}
