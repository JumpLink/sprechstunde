import { _ } from './i18n.svelte';
import { modelLabel } from './models.svelte';
import type { AdminState, Choice, Preset } from './types';

export const describeChoice = (choice: Choice | undefined): string =>
  choice
    ? [choice.provider, choice.model && modelLabel(choice.provider, choice.model), choice.voice]
        .filter(Boolean)
        .join(' · ')
    : '';

/** A preset's label for its id, as the calls tables show presets by id. */
export const presetLabel = (state: AdminState | undefined, id: string): string =>
  state?.settings.presets.find((preset) => preset.id === id)?.label ?? id;

/** What a slot (primary or fallback) resolves to: a preset, the environment's voice, or nothing. */
export function resolveSlot(
  state: AdminState,
  slot: 'primary' | 'fallback',
): { label: string; detail: string; preset?: Preset; choice?: { provider: string; model?: string; voice?: string } } {
  const id = state.settings.active[slot];
  const preset = id ? state.settings.presets.find((candidate) => candidate.id === id) : undefined;
  if (preset) {
    return {
      label: preset.label,
      detail: [preset.provider, preset.model, preset.voice].filter(Boolean).join(' · '),
      preset,
      choice: preset,
    };
  }
  const env = state.envVoice[slot];
  if (env) return { label: _('Environment'), detail: describeChoice(env), choice: env };
  return { label: _('Not set'), detail: '' };
}
