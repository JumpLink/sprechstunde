import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { voice } from '@livekit/agents';
import { _ } from '../i18n.js';

/**
 * Debug transcripts are personal data: off unless `SPRECHSTUNDE_TRANSCRIPT_DIR` is set, and meant
 * for test calls only. Production leaves the variable empty.
 */
export function transcriptDir(): string | undefined {
  return process.env.SPRECHSTUNDE_TRANSCRIPT_DIR || undefined;
}

type SessionEvent =
  | voice.ConversationItemAddedEvent
  | voice.UserInputTranscribedEvent
  | voice.AgentFalseInterruptionEvent
  | voice.AgentStateChangedEvent
  | voice.UserStateChangedEvent;

/** One JSONL line per event; `null` for what is not worth keeping (interim transcripts, handoffs). */
export function transcriptLine(event: SessionEvent, now: number): Record<string, unknown> | null {
  switch (event.type) {
    case 'conversation_item_added': {
      const item = event.item;
      if (item.type !== 'message') return null;
      return { ts: now, type: 'item', role: item.role, interrupted: item.interrupted, text: item.textContent ?? '' };
    }
    case 'user_input_transcribed':
      return event.isFinal ? { ts: now, type: 'stt_final', text: event.transcript } : null;
    case 'agent_false_interruption':
      return { ts: now, type: 'false_interruption', resumed: event.resumed };
    case 'agent_state_changed':
      return { ts: now, type: 'agent_state', state: event.newState };
    case 'user_state_changed':
      return { ts: now, type: 'user_state', state: event.newState };
    default:
      return null;
  }
}

/** Writes `<dir>/<date>/<jobId>.jsonl`. A failing write warns once and never ends the call. */
export function attachTranscript(session: voice.AgentSession, jobId: string, dir: string): void {
  const day = join(dir, new Date().toISOString().slice(0, 10));
  const file = join(day, `${jobId}.jsonl`);
  let warned = false;
  const write = (event: SessionEvent) => {
    const line = transcriptLine(event, Date.now());
    if (!line) return;
    try {
      mkdirSync(day, { recursive: true });
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (error) {
      if (!warned) console.warn(_('cannot write transcript'), (error as Error).message);
      warned = true;
    }
  };
  const E = voice.AgentSessionEventTypes;
  session.on(E.ConversationItemAdded, write);
  session.on(E.UserInputTranscribed, write);
  session.on(E.AgentFalseInterruption, write);
  session.on(E.AgentStateChanged, write);
  session.on(E.UserStateChanged, write);
  console.warn(_('debug transcripts are on; this stores what callers say'), file);
}
