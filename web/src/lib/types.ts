/** The shapes of what the admin server answers. Kept by hand next to `src/admin/server.ts`. */

export type Provider = 'mistral' | 'cartesia' | 'openrouter' | 'pocket' | 'kugel';

export interface Preset {
  id: string;
  label: string;
  provider: Provider;
  model?: string;
  voice?: string;
  refAudio?: string;
  name?: string;
}

export interface Settings {
  presets: Preset[];
  active: { primary?: string; fallback?: string };
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
}

export interface ProfileEntry {
  file: string;
  id: string;
  name?: string;
  locale?: string;
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
  presets: Array<{ preset?: string; calls: number; provider?: string; summary: Record<string, Summary> }>;
  calls: Array<{
    start: string;
    seconds: number;
    lines: number;
    preset?: string;
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
  gender?: string;
  description?: string;
  sampleUrl?: string;
}

export interface Catalog {
  provider: string;
  available: boolean;
  reason?: string;
  models: Array<{ id: string; label: string }>;
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
