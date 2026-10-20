/**
 * Entry point of the settings UI: `npm run admin`, or `node dist/admin/main.js` in the container.
 *
 * It runs next to the agent, not inside it — a reload of the UI must never touch a call in
 * progress, and the agent reads the file the UI writes at the start of the next call.
 */

import { join } from 'node:path';
import { initializeLogger } from '@livekit/agents';
import { loadProfile } from '../core/profile.js';
import { DEFAULT_TENANT, settingsFile } from '../core/settings.js';
import { _ } from '../i18n.js';
import { mistralClient } from '../mistral.js';
import { ttsSynthesizer } from './preview.js';
import { createKnowledgeRuntime, runDue, SCHEDULE_INTERVAL_MS } from './knowledge-runtime.js';
import { createAdminServer, DEFAULT_PORT, HOST } from './server.js';

function port(env: NodeJS.ProcessEnv): number {
  const raw = env.SPRECHSTUNDE_ADMIN_PORT;
  if (!raw) return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(_('%s must be a port number').replace('%s', 'SPRECHSTUNDE_ADMIN_PORT'));
  }
  return value;
}

function main(): void {
  // A TTS plugin takes its logger when it is constructed, and every preview constructs one. In the
  // agent the worker CLI does this; here nothing else would, and the first preview would fail with
  // "logger not initialized". Warnings only: the UI says what it did on stdout itself.
  initializeLogger({ pretty: true, level: 'warn' });
  const profile = loadProfile(process.env.SPRECHSTUNDE_PROFILE);
  // The greeting is the one sentence every caller hears, so it is the honest sample to compare
  // voices on.
  const knowledge = createKnowledgeRuntime(process.env);
  const server = createAdminServer({
    knowledge: knowledge.api,
    settingsPath: settingsFile(),
    metricsDir: process.env.SPRECHSTUNDE_METRICS_DIR || join('var', 'metrics'),
    sampleText: profile.greeting,
    startProfile: { id: profile.id, name: profile.assistantName, locale: profile.locale },
    loadStartProfile: () => loadProfile(process.env.SPRECHSTUNDE_PROFILE),
    // Built per preview: a key that is missing only matters for the vendor that needs it, and
    // the UI must still start and show everything else.
    synthesize: ttsSynthesizer(() => mistralClient(), profile),
  });

  // The admin is the only writer of the knowledge database, so it also keeps the sources fresh.
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void runDue(knowledge.service, DEFAULT_TENANT).finally(() => (running = false));
  };
  setInterval(tick, SCHEDULE_INTERVAL_MS).unref();
  setTimeout(tick, 30_000).unref();

  const listenOn = port(process.env);
  server.listen(listenOn, HOST, () => {
    // The URL stays out of the catalogue: gettext warns about embedded URLs, and a translator has
    // nothing to decide about one.
    console.log(_('settings UI on %s').replace('%s', `http://${HOST}:${listenOn}`));
    console.log(_('settings file: %s').replace('%s', settingsFile()));
  });
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
