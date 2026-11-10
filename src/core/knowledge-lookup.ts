import type { LlmTool } from './tools.js';

/**
 * Long knowledge sections (a whole menu) are not put into the prompt: a small model loses single
 * lines in 25 000 characters and mixes up the prices of neighbouring dishes (measured 2026-11-10,
 * `mistral-small` and `-medium`). The prompt keeps a summary per long section; the full text
 * comes back through a tool when a caller asks for it.
 */
export const LOOKUP_TOOL_NAME = 'look_up_details';

/** Appended to the heading of a section that shows only its summary. */
export const DETAILS_MARKER = '(details on request)';

/** Sections up to this size stay in the prompt in full. */
const INLINE_LIMIT = 1500;
const SUMMARY_CHARS = 400;

const OPEN = '<reference-data>';
const CLOSE = '</reference-data>';

/** One section as `renderSnapshot` writes it: heading, source line, fenced body. */
const SECTION = /^## (.+)\n(Source: .+)\n<reference-data>\n([\s\S]*?)\n<\/reference-data>/gm;

export interface SplitReference {
  /** The snapshot with long sections cut down to their summary. */
  text: string;
  /** Full body per section name, for the tool. */
  details: Map<string, string>;
}

/** The first paragraph, cut at a word: for a menu it is the description written for the assistant. */
function summaryOf(body: string): string {
  const first = body.trim().split(/\n\s*\n/)[0] ?? '';
  const flat = first.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUMMARY_CHARS) return flat;
  return `${flat.slice(0, SUMMARY_CHARS).replace(/\s+\S*$/, '')}…`;
}

export function splitReference(snapshot: string): SplitReference {
  const details = new Map<string, string>();
  const text = snapshot.replace(SECTION, (whole, title: string, source: string, body: string) => {
    if (body.length <= INLINE_LIMIT) return whole;
    let name = title;
    for (let n = 2; details.has(name); n++) name = `${title} (${n})`;
    details.set(name, body);
    return `## ${name} ${DETAILS_MARKER}\n${source}\n${OPEN}\n${summaryOf(body)}\n${CLOSE}`;
  });
  return { text, details };
}

/** The tool as the model sees it: the section names are the only valid values. */
export function lookupTool(names: string[]): LlmTool {
  return {
    name: LOOKUP_TOOL_NAME,
    description: `Get the full text of a reference section marked "${DETAILS_MARKER}", such as a menu with its dishes and prices.`,
    parameters: {
      type: 'object',
      properties: { section: { type: 'string', enum: names, description: 'The name of the section.' } },
      required: ['section'],
    },
  };
}

/** What the tool returns: the body, fenced like the rest of the reference data. */
export function lookupDetails(details: Map<string, string>, section: unknown): string {
  const wanted = typeof section === 'string' ? section.trim().toLowerCase() : '';
  const name = [...details.keys()].find((key) => key.toLowerCase() === wanted);
  const body = name === undefined ? undefined : details.get(name);
  if (body === undefined) return `No such section. Sections: ${[...details.keys()].join(', ')}.`;
  return `${OPEN}\n${body}\n${CLOSE}`;
}
