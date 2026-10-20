import type { Fact, Profile } from './profile.js';
import { buildInstructions, type Persona } from './prompt.js';
import { maskTransferTarget, type ToolDescriptor, toolDescriptors, transferRequest } from './tools.js';

/** Everything a call knows and can do for one profile, as the admin UI shows it. Read-only. */
export interface Knowledge {
  profile: {
    id: string;
    assistantName: string;
    locale: string;
    timeZone: string;
  };
  greeting: string;
  instructions: string;
  facts: Fact[];
  /** `targetMasked` hides all but the last two digits: the number is a person's phone. */
  transfer: { announce: string; targetMasked: string } | null;
  fallback: string | null;
  /** The exact system prompt a call starting at `now` gets. */
  systemPrompt: string;
  tools: ToolDescriptor[];
}

/**
 * Built from the same functions the agent calls (`buildInstructions`, `transferRequest`,
 * `toolDescriptors`), so what the page shows is what the model gets.
 */
export function describeKnowledge(
  profile: Profile,
  now: Date,
  override?: { number?: string; sipHost?: string },
  persona?: Persona,
): Knowledge {
  const request = transferRequest(profile, override);
  return {
    profile: {
      id: profile.id,
      assistantName: profile.assistantName,
      locale: profile.locale,
      timeZone: profile.timeZone,
    },
    greeting: profile.greeting,
    instructions: profile.instructions,
    facts: profile.facts,
    transfer: request
      ? {
          announce: request.announce,
          targetMasked: maskTransferTarget(request.target),
        }
      : null,
    fallback: profile.fallback ?? null,
    systemPrompt: buildInstructions(profile, now, persona),
    tools: toolDescriptors(),
  };
}
