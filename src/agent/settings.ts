import { readSettings, type Settings, settingsFile } from '../core/settings.js';
import { _ } from '../i18n.js';

/**
 * The settings as they are right now, read at the start of every call so a change in the admin UI
 * reaches the next call without a restart.
 *
 * A missing file is the normal state: the environment then decides, exactly as before the UI
 * existed. A broken file must never cost a call either, so it is reported and skipped — once per
 * call, because that is the moment the operator notices their change did not take.
 */
export function currentSettings(env: NodeJS.ProcessEnv = process.env): Settings | undefined {
  try {
    return readSettings(settingsFile(env));
  } catch (error) {
    console.warn(_('ignoring the settings file, using the environment instead:'), (error as Error).message);
    return undefined;
  }
}
