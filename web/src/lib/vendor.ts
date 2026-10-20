import { _ } from './i18n.svelte';

export interface Vendor {
  /** The name people read, in full. */
  name: string;
  /** Two letters on the vendor colour; no logo, which is the vendor's trademark. */
  mono: string;
  /** The CSS custom property that holds the vendor colour in the current theme. */
  colour: string;
}

const MONOGRAMS: Record<string, string> = {
  kugel: 'Ku',
  cartesia: 'Ca',
  mistral: 'Mi',
  openrouter: 'OR',
  pocket: 'Po',
};

/** OpenRouter relays other vendors' models (`openai/gpt-…`); the upstream is what tells its voices apart. */
const upstream = (model: string | undefined): string | undefined => {
  const vendor = model?.split('/')[0]?.trim();
  return vendor && model?.includes('/') ? vendor : undefined;
};

export function vendorOf(provider: string, model?: string): Vendor {
  const known = provider in MONOGRAMS;
  const name =
    provider === 'kugel'
      ? 'Kugel Audio'
      : provider === 'cartesia'
        ? 'Cartesia'
        : provider === 'mistral'
          ? 'Mistral'
          : provider === 'openrouter'
            ? ['OpenRouter', upstream(model)].filter(Boolean).join(' · ')
            : provider === 'pocket'
              ? _('Pocket TTS (local)')
              : provider;
  return {
    name,
    mono: MONOGRAMS[provider] ?? provider.slice(0, 2),
    colour: `var(--vendor-${known ? provider : 'other'})`,
  };
}
