import { mkdir, writeFile } from 'node:fs/promises';
import * as inspector from 'node:inspector';
import { type JobContext, type JobProcess, llm, stt, tokenize, tts, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as mistral from '@livekit/agents-plugin-mistralai';
import * as silero from '@livekit/agents-plugin-silero';
import { ParticipantKind } from '@livekit/rtc-node';
import { buildInstructions } from '../core/prompt.js';
import type { Profile } from '../core/profile.js';
import { transferRequest } from '../core/tools.js';
import { _ } from '../i18n.js';
import { recordMetrics } from './metrics.js';
import { transferSipParticipant } from './transfer.js';
import { StallGuardSTT } from './stt-guard.js';
import { ContiguousSTT } from './stt-merge.js';
import { HedgedTTS } from './tts-hedge.js';
import { resolveTtsVoice } from './tts-voice.js';

const DEFAULT_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602';
const DEFAULT_LLM_MODEL = 'mistral-small-latest';
const DEFAULT_TTS_MODEL = 'voxtral-mini-tts-latest';
const FALLBACK_STT_MODEL = 'voxtral-mini-latest';

// Mistral's realtime STT only finalises when the VAD reports end of speech, so the silence the
// VAD waits for (Silero default 550 ms) adds straight to every reply. The turn detector still
// decides whether a pause ends the turn.
const VAD_MIN_SILENCE_MS = 300;
// One TTS request per sentence re-clones the voice each time and it audibly drifts. Send the
// first sentence alone (fast first audio), then batch the rest into larger chunks.
const TTS_FIRST_CHUNK_CHARS = 20;
const TTS_CHUNK_CHARS = 150;
const TTS_MAX_CHUNK_CHARS = 400;
// Mistral TTS usually sends first audio after 0.4–0.8 s, but now and then holds a chunk back for
// 6–9 s (measured 2026-10-16); past this point a second identical request races the first.
const TTS_HEDGE_MS = 1500;
// A realtime transcript normally lands 0.4–0.6 s after the end of speech (measured 2026-10-16).
const STT_STALL_MS = 2500;

const CPU_PROFILE_DIR = 'var/prof';

/**
 * `SPRECHSTUNDE_CPU_PROF=1` records a V8 CPU profile of the job process.
 *
 * The event-loop watchdog only reports a block after it is over and names no function, so a
 * 12 s stall (measured 2026-10-16) leaves nothing to look at. The profile is written to
 * `var/prof/<jobId>.cpuprofile` when the session closes — open it in Chrome DevTools or
 * `speedscope`. Off by default: profiling costs samples on every tick.
 */
function startCpuProfile(jobId: string): (() => Promise<void>) | undefined {
  if (process.env.SPRECHSTUNDE_CPU_PROF !== '1') return undefined;

  const session = new inspector.Session();
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.start');

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    const profile = await new Promise<inspector.Profiler.Profile | undefined>((resolve) => {
      session.post('Profiler.stop', (error, result) => resolve(error ? undefined : result?.profile));
    });
    session.disconnect();
    if (!profile) return;
    const file = `${CPU_PROFILE_DIR}/${jobId.replace(/[^\w.-]/g, '_')}.cpuprofile`;
    await mkdir(CPU_PROFILE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(profile));
    console.log(_('CPU profile written to'), file);
  };
}

export async function prewarm(proc: JobProcess): Promise<void> {
  proc.userData.vad = await silero.VAD.load({ minSilenceDuration: VAD_MIN_SILENCE_MS });
}

/**
 * Realtime STT first; Mistral's realtime queue overflows now and then (`TooManyRequestsError`,
 * `QueueOverflowError`), so fall back to the batch model, segmented by the VAD.
 */
function buildStt(vad: silero.VAD, language: string): stt.STT {
  // Two instances of the same batch model, not one shared: the guard's rescue and the fallback
  // slot have separate lifecycles (the adapter closes its own instances) and separate metrics.
  const batch = () => new ContiguousSTT(new mistral.STT({ model: FALLBACK_STT_MODEL, language }));
  return new stt.FallbackAdapter({
    sttInstances: [
      new StallGuardSTT(
        // Without `vad` the plugin loads its own Silero per call, which blocks the event loop.
        new mistral.STT({ model: process.env.SPRECHSTUNDE_STT_MODEL || DEFAULT_STT_MODEL, language, vad }),
        STT_STALL_MS,
        batch(),
      ),
      batch(),
    ],
    vad,
    retryIntervalMs: 1000,
  });
}

function buildTts(profile: Profile): tts.TTS {
  const base = new mistral.TTS({
    model: process.env.SPRECHSTUNDE_TTS_MODEL || DEFAULT_TTS_MODEL,
    ...resolveTtsVoice(profile),
  });
  return new tts.StreamAdapter(
    new HedgedTTS(base, TTS_HEDGE_MS),
    new tokenize.basic.SentenceTokenizer({
      firstTokenLength: TTS_FIRST_CHUNK_CHARS,
      minTokenLength: TTS_CHUNK_CHARS,
      maxTokenLength: TTS_MAX_CHUNK_CHARS,
    }),
  );
}

export async function runAssistant(ctx: JobContext, profile: Profile): Promise<void> {
  const stopCpuProfile = startCpuProfile(ctx.job?.id || 'job');

  // `lk agent console` runs a fake job without a room: there is no participant to wait for.
  const participant = ctx.isFakeJob ? undefined : await ctx.waitForParticipant();

  // No fact lookup tool: the facts are in the instructions, and a tool call costs a second LLM
  // round (0.4–0.9 s measured 2026-10-16).
  const tools = {
    transfer_to_human: llm.tool({
      description: 'Transfer the call to a person. Only call this after the caller agreed.',
      execute: async (_args, opts) => {
        const request = transferRequest(profile, process.env.TRANSFER_TARGET_NUMBER || undefined);
        if (!request) return 'Transfer is not available.';
        if (participant?.kind !== ParticipantKind.SIP) {
          return 'Transfer is only available for phone calls. Say that you cannot connect the caller now and offer nothing else instead.';
        }
        await opts.ctx.session.say(request.announce).waitForPlayout();
        try {
          await transferSipParticipant(ctx.room.name ?? '', participant.identity, request.target);
        } catch (error) {
          console.error(_('transfer failed'), (error as Error).message);
          return 'The transfer failed. Apologise and say the caller can try again later.';
        }
        return 'Transfer started.';
      },
    }),
  };

  const vad = ctx.proc.userData.vad as silero.VAD;
  const session = new voice.AgentSession({
    vad,
    stt: buildStt(vad, profile.locale.split('-')[0]!),
    llm: new mistral.LLM({ model: process.env.SPRECHSTUNDE_LLM_MODEL || DEFAULT_LLM_MODEL }),
    tts: buildTts(profile),
    turnHandling: {
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      // The LLM already starts on the interim transcript; also start the voice, which saves the
      // TTS first-byte time (~0.6 s) whenever the guessed turn holds.
      preemptiveGeneration: { preemptiveTts: true },
      // Adaptive interruption runs on LiveKit Cloud inference. `dev` tries it (caller audio would go
      // to a third party), fails at job start and falls back to VAD; `start` never tries. Pin VAD
      // so dev tests behave like production and no audio leaves for LiveKit Cloud.
      interruption: { mode: 'vad' },
    },
  });

  session.on(voice.AgentSessionEventTypes.MetricsCollected, (event) => recordMetrics(event.metrics));
  // The session closes when the caller hangs up, but the job would sit in the room until the
  // room times out; whoever joins that room meanwhile gets a silent agent and no new dispatch.
  session.on(voice.AgentSessionEventTypes.Close, () => {
    void (async () => {
      // The profile has to be on disk before the shutdown tears the process down.
      await stopCpuProfile?.().catch((error) => console.error(_('CPU profile failed'), error));
      ctx.shutdown('session closed');
    })();
  });

  await session.start({
    agent: new voice.Agent({ instructions: buildInstructions(profile, new Date()), tools }),
    room: ctx.room,
  });
  session.say(profile.greeting);
}
