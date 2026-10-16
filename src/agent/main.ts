import { fileURLToPath } from 'node:url';
import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent } from '@livekit/agents';
import { loadProfile } from '../core/profile.js';
import { _ } from '../i18n.js';
import { prewarm, runAssistant } from './assistant.js';
import { runEcho } from './echo.js';

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
    console.log(_('starting assistant with profile'), profile.id);
    await runAssistant(ctx, profile);
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: process.env.SPRECHSTUNDE_AGENT_NAME || 'sprechstunde',
    }),
  );
}
