import { basename } from 'node:path';
import { Mistral } from '@mistralai/mistralai';
import { refAudioFromFile } from '../agent/tts-voice.js';
import { _ } from '../i18n.js';

/** A function, not a constant: the catalogue is only loaded once the process has a locale. */
const usage = () => _('usage: voice create <name> <audio file> [language] | voice list | voice delete <id>');

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error(_('%s must be set').replace('%s', 'MISTRAL_API_KEY'));
  const client = new Mistral({ apiKey });

  switch (command) {
    case 'create': {
      const [name, file, language = 'de'] = args;
      if (!name || !file) throw new Error(usage());
      const voice = await client.audio.voices.create({
        name,
        languages: [language],
        sampleAudio: refAudioFromFile(file),
        sampleFilename: basename(file),
      });
      console.log(_('created voice %s').replace('%s', voice.id));
      console.log(
        _('use it with SPRECHSTUNDE_TTS_VOICE=%s or "voice": { "ttsVoice": "%s" }').replaceAll('%s', voice.id),
      );
      break;
    }
    case 'list': {
      const { items } = await client.audio.voices.list({ type: 'custom' });
      for (const voice of items) {
        console.log(
          `${voice.id}  ${voice.name}  ${(voice.languages ?? []).join(',')}  ${voice.createdAt.toISOString()}`,
        );
      }
      break;
    }
    case 'delete': {
      const [voiceId] = args;
      if (!voiceId) throw new Error(usage());
      await client.audio.voices.delete({ voiceId });
      console.log(_('deleted voice %s').replace('%s', voiceId));
      break;
    }
    default:
      throw new Error(usage());
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
