/**
 * Audio tags: a cue in square brackets that tells a voice how to say the words after it, as in
 * `[chuckles] Das sagen alle.` A voice that reads them (ElevenLabs v3 and v4) never speaks the tag;
 * any other voice would read it out, so text meant for one of those goes through
 * {@link AudioTagStripper} first.
 */
export interface AudioTag {
  /** The cue without its brackets. The vendor's examples are English, and English cues work in any language. */
  tag: string;
  /** When the model may use it; goes into the system prompt. */
  use: string;
}

/**
 * The cues a phone call can use. The vendor accepts free text in brackets, sound effects included;
 * a short fixed list keeps the model from inventing cues that sound odd on a phone line, and leaves
 * out whispering, which the line swallows.
 * https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices (2026-11-06)
 */
export const AUDIO_TAGS: readonly AudioTag[] = [
  { tag: 'warmly', use: 'a kind, welcoming sentence, such as thanks or wishing the caller a good visit' },
  { tag: 'chuckles', use: 'a light, amused remark' },
  { tag: 'laughs softly', use: 'when the caller makes a joke or says something genuinely funny' },
  { tag: 'sighs', use: 'sympathy with something unwelcome, such as a fully booked evening' },
  { tag: 'thoughtful', use: 'an answer you take a moment to consider' },
];

/** The prompt lines that teach the model the cues; none without any. */
export function audioTagLines(tags: readonly AudioTag[]): string[] {
  if (tags.length === 0) return [];
  return [
    'Your voice understands audio tags: a cue in square brackets right before a sentence changes how that sentence is spoken. The tag itself is never spoken.',
    `Use only these tags: ${tags.map(({ tag, use }) => `[${tag}] for ${use}`).join('; ')}.`,
    'Use at most one tag per reply; most replies need none. Put it directly before the sentence it colours, never in the middle of a word or a number.',
    'Never laugh or chuckle when the caller complains, is worried or upset, or when you have to say no. Never put anything else in square brackets.',
    'For a short pause, write an ellipsis (…), not a tag.',
  ];
}

/** A `[` that is still open after this many characters was no tag; it is spoken as text. */
const MAX_TAG_CHARS = 40;

/**
 * Removes audio tags from text that arrives in pieces, as an LLM streams it. A tag split over two
 * pieces (`[chuck` + `les] Na`) is held back until it closes, so no half of it reaches the voice.
 * The space a removed tag leaves behind is dropped when another one is already there, so the
 * voice reads "Na gut", not "Na  gut".
 */
export class AudioTagStripper {
  #held = '';
  #afterTag = false;
  /** Whether the text emitted so far is empty or ends in whitespace. */
  #atGap = true;

  /** Feed a piece; returns the text that can be spoken now (may be empty). */
  push(text: string): string {
    let out = '';
    for (const char of text) out += this.#take(char);
    return out;
  }

  /**
   * The end of a segment: an unclosed `[…` was no tag and is released as it is. What follows starts
   * a new segment, so a tag at its start takes its space with it.
   */
  flush(): string {
    const rest = this.#held;
    this.#held = '';
    this.#afterTag = false;
    this.#atGap = true;
    return rest;
  }

  #take(char: string): string {
    if (this.#held) {
      if (char === ']') {
        this.#held = '';
        this.#afterTag = true;
        return '';
      }
      if (char === '[' || char === '\n' || this.#held.length >= MAX_TAG_CHARS) {
        const released = this.#emit(this.#held);
        this.#held = '';
        return released + this.#take(char);
      }
      this.#held += char;
      return '';
    }
    if (char === '[') {
      this.#held = char;
      return '';
    }
    if (this.#afterTag && /\s/.test(char)) {
      this.#afterTag = false;
      if (this.#atGap) return '';
    }
    this.#afterTag = false;
    return this.#emit(char);
  }

  #emit(text: string): string {
    if (text) this.#atGap = /\s$/.test(text);
    return text;
  }
}

/** {@link AudioTagStripper} over one complete text. */
export function stripAudioTags(text: string): string {
  const stripper = new AudioTagStripper();
  return stripper.push(text) + stripper.flush();
}
