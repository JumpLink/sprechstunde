import { _ } from '$lib/i18n.svelte';

export const ageLabel = (age: string): string =>
  ({ young: _('Young'), middle: _('Middle-aged'), old: _('Older') })[age] ?? age;
