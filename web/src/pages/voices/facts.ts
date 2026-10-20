import { _ } from '$lib/i18n.svelte';

export const ageLabel = (age: string): string =>
  ({ young: _('Young'), middle: _('Middle-aged'), old: _('Older') })[age] ?? age;

/** `narrative_story` -> "Narrative story": a vendor word nobody translated still reads as text. */
export const prettify = (word: string): string => {
  const text = word.replaceAll(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const categoryLabel = (category: string): string =>
  ({
    premade: _('Premade'),
    cloned: _('Cloned'),
    designed: _('Designed'),
    conversational: _('Conversational'),
    narrative: _('Narrative'),
    narrative_story: _('Storytelling'),
    characters: _('Characters'),
    characters_animation: _('Animated characters'),
    informative_educational: _('Informative and educational'),
    entertainment_tv: _('Entertainment and TV'),
    advertisement: _('Advertising'),
  })[category] ?? prettify(category);

export const qualityLabel = (quality: string): string =>
  ({ low: _('Basic quality'), mid: _('Medium quality'), high: _('High quality') })[quality.toLowerCase()] ??
  prettify(quality);
