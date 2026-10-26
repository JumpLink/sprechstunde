import { fileURLToPath } from 'node:url';
import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent } from '@livekit/agents';
import { loadProfile } from '../core/profile.js';
import { _ } from '../i18n.js';
import { prewarm, runAssistant } from './assistant.js';
import { runEcho } from './echo.js';
import { redactPiiLogs } from './redact-logs.js';
import { exitUnhealthy, httpProbe, startWatchdog } from './watchdog.js';

// Every process that runs the worker imports this module, the forked job processes included.
redactPiiLogs();

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    if (process.env.SPRECHSTUNDE_MODE !== 'echo') await prewarm(proc);
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    if (process.env.SPRECHSTUNDE_MODE === 'echo') {
      await runEcho(ctx);
      return;
    }
    const profile = loadProfile();
    await runAssistant(ctx, profile);
  },
});

/** The health endpoint answers on loopback only: the watchdog below is its one reader, and on a server the default (all interfaces) would publish it. */
export function serverOptions(env: NodeJS.ProcessEnv): ServerOptions {
  return new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: env.SPRECHSTUNDE_AGENT_NAME || 'sprechstunde',
    host: '127.0.0.1',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // `start` runs under a restart policy (the container); in a `dev` terminal an exit only stops it.
  if (process.argv[2] === 'start') {
    startWatchdog({
      probe: httpProbe('http://127.0.0.1:8081/', 5_000),
      onDead: exitUnhealthy,
      intervalMs: 15_000,
      failures: 4,
    });
  }
  cli.runApp(serverOptions(process.env));
}
