import type { Fact, Profile } from './profile.js';

/** Channel-independent request; each channel decides how to carry it out. */
export interface TransferRequest {
  target: string;
  announce: string;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

/** Best fact by token overlap with topic (weighted double) and answer; null when nothing matches. */
export function lookupFact(profile: Profile, query: string): Fact | null {
  const wanted = new Set(tokens(query));
  let best: Fact | null = null;
  let bestScore = 0;
  for (const fact of profile.facts) {
    const topic = new Set(tokens(fact.topic));
    const answer = new Set(tokens(fact.answer));
    let score = 0;
    for (const token of wanted) {
      if (topic.has(token)) score += 2;
      else if (answer.has(token)) score += 1;
    }
    if (score > bestScore) {
      best = fact;
      bestScore = score;
    }
  }
  return best;
}

export function transferRequest(profile: Profile): TransferRequest | null {
  return profile.transfer ? { ...profile.transfer } : null;
}
