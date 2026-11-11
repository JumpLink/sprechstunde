/**
 * What an assistant can say about itself when a caller asks how it works or who built it. Built
 * from the configuration of the call, so the answer names the models that really run and never
 * drifts from them.
 */
export interface Technology {
  /** Language model and, when configured, the one asked when it fails. */
  llm: { model: string; fallback?: string };
  stt: { model: string; fallback?: string };
  /** The voice, then the voice that takes over; each with its vendor and model. */
  tts: { provider: string; model: string }[];
}

/** Who built the platform; shown only when named, and only the contact details that are set. */
export interface Builder {
  name: string;
  /** Where the developer works from, such as a town. */
  place?: string;
  email?: string;
  url?: string;
}

const VENDORS: Record<string, string> = {
  mistral: 'Mistral AI',
  cartesia: 'Cartesia',
  openrouter: 'OpenRouter',
  pocket: 'Kyutai Pocket TTS',
  kugel: 'KugelAudio',
  elevenlabs: 'ElevenLabs',
};

export function vendorName(provider: string): string {
  return VENDORS[provider] ?? provider;
}

function pair(main: string, fallback: string | undefined): string {
  return fallback && fallback !== main ? `${main}, with ${fallback} as the fallback` : main;
}

/** The voice and the fallback voice, each as "vendor, model". */
function voices(tts: Technology['tts']): string {
  const named = tts.map((voice) => `${vendorName(voice.provider)}, model ${voice.model}`);
  const [first, ...rest] = named;
  return rest.length > 0 ? `${first}, with ${rest.join('; ')} as the fallback` : (first ?? '');
}

export function aboutBlock(technology: Technology, builder?: Builder): string {
  const contact = [builder?.email && `e-mail ${builder.email}`, builder?.url && `website ${builder.url}`].filter(
    Boolean,
  );
  return [
    'About yourself. You know all of this and may say it when the caller asks how you work, what technology or models you use, or who made you. Do not bring it up in an unrelated conversation. When a caller is curious about you, answer in a few short sentences and offer more: that you can name the models behind you, or who built you and how to reach them. Name only what is listed here and add no detail about these models or about how your voice was made that you were not given:',
    `- Language model: ${pair(technology.llm.model, technology.llm.fallback)}, hosted by Mistral AI.`,
    `- Speech recognition: ${pair(technology.stt.model, technology.stt.fallback)}, from Mistral AI.`,
    `- Voice: ${voices(technology.tts)}.`,
    '- The call runs on the open-source LiveKit Agents framework, with Silero for detecting speech and a LiveKit model for detecting the end of a turn, behind a SIP gateway built on Asterisk and LiveKit SIP.',
    ...(builder
      ? [
          `- The platform was built by ${builder.name}, a freelance software developer${builder.place ? ` from ${builder.place}` : ''}, who also takes on projects like this.${
            contact.length > 0
              ? ` When asked who built you, name them and then offer the contact details yourself, for example by asking whether the caller wants them; give ${contact.join(' and ')} only once the caller wants them or wants something like this for their own business. Speak the address in the language of the call so it can be written down by phone: the @ and every dot as words (in German "ät" and "Punkt"), never leave one out.`
              : ''
          } Say nothing else about the developer: no age, looks or other details.`,
        ]
      : []),
  ].join('\n');
}
