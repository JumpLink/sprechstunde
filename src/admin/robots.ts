import { matchTokens, tokenize } from './wildcard.js';

/** A parsed robots.txt, reduced to the rules that apply to one user agent. */
export interface RobotsRules {
  allowed(path: string): boolean;
}

interface Rule {
  allow: boolean;
  tokens: ReturnType<typeof tokenize>;
  anchored: boolean;
  length: number;
}

export const ALLOW_ALL: RobotsRules = { allowed: () => true };
export const DISALLOW_ALL: RobotsRules = { allowed: () => false };

/**
 * RFC 9309: the group naming our product wins over `*`; inside it the longest matching rule wins
 * and `Allow` beats `Disallow` on a tie. An empty `Disallow:` allows everything.
 */
export function parseRobots(text: string, agent: string): RobotsRules {
  const wanted = agent.toLowerCase();
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let current: { agents: string[]; rules: Rule[] } | undefined;
  let collecting = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    const colon = clean.indexOf(':');
    if (colon < 0) continue;
    const field = clean.slice(0, colon).trim().toLowerCase();
    const value = clean.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!collecting || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collecting = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      collecting = false;
      if (value !== '') {
        const anchored = value.endsWith('$');
        current.rules.push({
          allow: field === 'allow',
          tokens: tokenize(anchored ? value.slice(0, -1) : value, false),
          anchored,
          length: value.length,
        });
      }
    } else {
      collecting = false;
    }
  }
  const named = groups.filter((group) => group.agents.some((name) => name !== '*' && wanted.startsWith(name)));
  const chosen = named.length > 0 ? named : groups.filter((group) => group.agents.includes('*'));
  const rules = chosen.flatMap((group) => group.rules);
  return {
    allowed(path) {
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!matchTokens(rule.tokens, path, !rule.anchored)) continue;
        if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}
