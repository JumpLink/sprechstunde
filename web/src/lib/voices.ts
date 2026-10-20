import { _ } from './i18n.svelte';
import { modelLabel } from './models.svelte';
import type { AdminState, Character, Choice, Gender, VoiceSpec } from './types';

export const describeChoice = (choice: Choice | undefined): string =>
  choice
    ? [choice.provider, choice.model && modelLabel(choice.provider, choice.model), choice.voice]
        .filter(Boolean)
        .join(' · ')
    : '';

/** A character's name for its id, as the calls tables show characters by id. */
export const characterName = (state: AdminState | undefined, id: string): string =>
  state?.settings.characters.find((character) => character.id === id)?.name ?? id;

export const defaultCharacter = (state: AdminState): Character | undefined =>
  state.settings.characters.find((character) => character.id === state.settings.defaultCharacter);

export const genderLabel = (gender: Gender): string =>
  ({ female: _('Female'), male: _('Male'), neutral: _('Neutral') })[gender];

/** What a slot (voice or fallback) of the default character resolves to: the character, the environment's voice, or nothing. */
export function resolveSlot(
  state: AdminState,
  slot: 'primary' | 'fallback',
): { label: string; choice?: { provider: string; model?: string; voice?: string } } {
  const character = defaultCharacter(state);
  const spec: VoiceSpec | undefined = slot === 'primary' ? character?.voice : character?.fallbackVoice;
  if (character && spec) return { label: character.name, choice: spec };
  // A character wins as a whole: without a fallback voice it has none, whatever the environment says.
  if (character) return { label: _('Not set') };
  const env = state.envVoice[slot];
  if (env) return { label: _('Environment'), choice: env };
  return { label: _('Not set') };
}

/** One or two letters for the avatar. */
export const initials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase();
};
