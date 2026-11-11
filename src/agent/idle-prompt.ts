import { voice } from '@livekit/agents';

/** Silence that counts as a caller who is gone or waiting (seconds, as `userAwayTimeout` takes it). */
export const AWAY_TIMEOUT_S = 12;

/** Questions the assistant asks into the silence before it keeps quiet until the caller speaks. */
const MAX_NUDGES = 2;

const NUDGES = [
  'The caller has been silent for a while. Ask briefly, in one short sentence, whether they are still there or whether you can help with anything else.',
  'The caller is still silent. Say once, in one short sentence, that they can ask whenever they are ready, and that you are here. Do not ask another question.',
];

/**
 * Decides when to speak into a silence. LiveKit marks the caller `away` after `AWAY_TIMEOUT_S`
 * without a word once the assistant has stopped speaking; phone test 2026-11-11: nothing came, the
 * caller was left in a silent line. After `MAX_NUDGES` the assistant stops, so a caller who put the
 * phone down is not nagged, and a line that stays open costs only the caller's own call.
 */
export class IdlePrompt {
  private count = 0;

  /** The instruction for the next reply, or `undefined` when the assistant stays quiet. */
  next(state: voice.UserState): string | undefined {
    if (state === 'speaking') {
      this.count = 0;
      return undefined;
    }
    if (state !== 'away' || this.count >= MAX_NUDGES) return undefined;
    return NUDGES[this.count++];
  }
}

export function attachIdlePrompt(session: voice.AgentSession): void {
  const idle = new IdlePrompt();
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    const instructions = idle.next(event.newState);
    if (instructions) session.generateReply({ instructions });
  });
}
