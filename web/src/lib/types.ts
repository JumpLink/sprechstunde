/** The shapes of what the admin server answers. Kept by hand next to `src/admin/server.ts`. */

export type Provider = 'mistral' | 'cartesia' | 'openrouter' | 'pocket' | 'kugel';

export type Gender = 'female' | 'male' | 'neutral';

export interface VoiceSpec {
  provider: Provider;
  model?: string;
  voice?: string;
  refAudio?: string;
}

/** Mirrors `Character` in `src/core/settings.ts`. */
export interface Character {
  id: string;
  tenantId: string;
  name: string;
  gender: Gender;
  /** Set on a character migrated from a preset: nobody has said yet. */
  genderUnknown?: boolean;
  voice: VoiceSpec;
  fallbackVoice?: VoiceSpec;
  tone?: string;
  color?: string;
}

export interface CharacterVenue {
  file: string | null;
  id: string;
  name?: string;
  explicit: boolean;
}

export interface CharactersView {
  tenantId: string;
  revision: string;
  default: string | null;
  characters: Array<Character & { usedBy: CharacterVenue[] }>;
  created?: { id: string };
}

export interface Settings {
  schemaVersion: number;
  characters: Character[];
  defaultCharacter?: string;
  llm: { model?: string; fallbackModel?: string; attemptTimeoutS?: number };
  profile?: string;
}

export interface Choice {
  provider: string;
  model: string;
  voice?: string;
}

export interface AdminState {
  settings: Settings;
  settingsError?: string;
  settingsPath: string;
  envVoice: { primary?: Choice; fallback?: Choice; error?: string };
  providers: Provider[];
  metricNames: string[];
  sampleText: string;
  keys: Record<string, boolean>;
  /** Whether the configured KugelAudio key speaks from the EU endpoint. */
  kugelEu: boolean;
}

export interface ProfileEntry {
  file: string;
  id: string;
  name?: string;
  locale?: string;
  /** The character this venue picked; none means the default one. */
  character?: string;
  error?: string;
}

export interface Profiles {
  profiles: ProfileEntry[];
  active: string | null;
  default: { id: string; name?: string; locale?: string } | null;
  error?: string;
}

export interface Summary {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface Latency {
  skipped: number;
  characters: Array<{ character?: string; calls: number; provider?: string; summary: Record<string, Summary> }>;
  calls: Array<{
    start: string;
    seconds: number;
    lines: number;
    character?: string;
    provider?: string;
    llmModel?: string;
    summary: Record<string, Summary>;
  }>;
}

export interface CatalogVoice {
  id: string;
  name: string;
  model?: string;
  languages: string[];
  gender?: Gender;
  description?: string;
  sampleUrl?: string;
  hasAvatar?: boolean;
  /** Only what the vendor reports; unset means unknown. */
  age?: 'young' | 'middle' | 'old';
  category?: string;
  quality?: string;
  verified?: boolean;
  /** A voice of the account itself, not one the vendor ships. */
  own?: boolean;
}

/** Mirrors `CatalogModel` in `src/admin/catalog.ts`; every field but `id` and `label` is vendor-sourced. */
export interface CatalogModel {
  id: string;
  label: string;
  description?: string;
  aliasOf?: string;
  aliases?: string[];
  latest?: boolean;
  deprecated?: boolean;
  deprecatedAt?: string;
  replacement?: string;
  contextLength?: number;
  maxOutput?: number;
  maxInput?: number;
  capabilities?: { tools?: boolean; vision?: boolean; reasoning?: boolean; audioIn?: boolean; audioOut?: boolean };
  pricing?: { prompt?: number; completion?: number };
  created?: string;
}

export interface Catalog {
  provider: string;
  available: boolean;
  reason?: string;
  models: CatalogModel[];
  voices: CatalogVoice[];
  fetchedAt: string;
}

export interface Fact {
  topic: string;
  answer: string;
  /** Index in the saved file; a new fact has none. */
  origin?: number;
}

/** What the page edits; the transfer target arrives masked and is sent only when changed. */
export interface Draft {
  assistantName: string;
  greeting: string;
  instructions: string;
  facts: Fact[];
  transfer: { announce: string; targetMasked: string } | null;
  fallback: string | null;
  character: string | null;
}

export interface HistoryVersion {
  version: string;
  at: string;
  size: number;
}

export interface Knowledge {
  editable: boolean;
  revision?: string;
  draft?: Draft;
  profile: { id: string; assistantName: string; locale: string; timeZone: string };
  file: string | null;
  source: 'selected' | 'active' | 'start';
  greeting: string;
  instructions: string;
  facts: Array<{ topic: string; answer: string }>;
  transfer: { announce: string; targetMasked: string } | null;
  fallback: string | null;
  systemPrompt: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
    availableWhen: string;
  }>;
}
