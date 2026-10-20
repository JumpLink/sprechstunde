import { api } from './api';
import { _, fill } from './i18n.svelte';
import type { AdminState, Catalog, CatalogModel } from './types';

/** What the agent asks Mistral for when the settings name no model. */
export const DEFAULT_LLM = 'mistral-small-latest';

const catalogs = $state<Record<string, Catalog | undefined>>({});
const requested = new Set<string>();

/** Load the catalog of each vendor once; the server caches them for an hour. */
export function ensureCatalogs(targets: string[]): void {
  for (const target of targets) {
    if (requested.has(target)) continue;
    requested.add(target);
    api<Catalog>('GET', `/api/catalog/${encodeURIComponent(target)}`)
      .then((catalog) => (catalogs[target] = catalog))
      .catch(() => requested.delete(target));
  }
}

export const catalogOf = (target: string): Catalog | undefined => catalogs[target];

export function findModel(target: string, id: string | undefined): CatalogModel | undefined {
  return id ? catalogs[target]?.models.find((model) => model.id === id) : undefined;
}

/** The readable name when the vendor's list is loaded and knows the id, else the id itself. */
export const modelLabel = (target: string, id: string): string => findModel(target, id)?.label ?? id;

export interface Use {
  target: string;
  id: string;
  role: 'primary' | 'fallback';
}

/** The models the settings and the environment make the agent use right now. */
export function modelsInUse(state: AdminState): Use[] {
  const uses: Use[] = [{ target: 'llm', id: state.settings.llm.model ?? DEFAULT_LLM, role: 'primary' }];
  if (state.settings.llm.fallbackModel) {
    uses.push({ target: 'llm', id: state.settings.llm.fallbackModel, role: 'fallback' });
  }
  for (const role of ['primary', 'fallback'] as const) {
    const preset = state.settings.presets.find((candidate) => candidate.id === state.settings.active[role]);
    const choice = preset ?? state.envVoice[role];
    if (choice?.model) uses.push({ target: choice.provider, id: choice.model, role });
  }
  return uses;
}

export function tokens(count: number): string {
  return count >= 1_000_000
    ? `${+(count / 1_000_000).toFixed(1)}M`
    : count >= 1000
      ? `${Math.round(count / 1000)}k`
      : String(count);
}

/** OpenRouter lists USD per token; a price per million is what people compare. */
export function perMillion(price: number): string {
  return `$${+(price * 1_000_000).toPrecision(4)}`;
}

/** The text of an option in a model list: the name, plus what tells similar ones apart. */
export function modelOption(model: CatalogModel): string {
  const parts = [model.label];
  if (model.latest) parts.push(_('newest version'));
  if (model.deprecated) parts.push(_('deprecated'));
  if (model.contextLength) parts.push(fill(_('%s tokens'), tokens(model.contextLength)));
  return parts.join(' · ');
}
