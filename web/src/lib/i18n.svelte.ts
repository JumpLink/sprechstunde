/**
 * Same convention as the server: English msgids, `_()` marks a string, German comes from the
 * catalogue `dev/i18n.sh compile` writes to `locale/de.json`. A missing entry shows the msgid.
 */

export type Language = 'en' | 'de';

const STORAGE_KEY = 'sprechstunde.language';

let messages = $state<Record<string, string>>({});
let language = $state<Language>('en');

export function _(msgid: string): string {
  return messages[msgid] || msgid;
}

/** `%s` (or `%1`, `%2`, …) placeholders, in the order of the values. */
export function fill(text: string, ...values: Array<string | number>): string {
  let index = 0;
  return text.replace(/%(\d|s)/g, (_match, key: string) =>
    String(values[key === 's' ? index++ : Number(key) - 1] ?? ''),
  );
}

export const currentLanguage = (): Language => language;

export async function setLanguage(next: Language): Promise<void> {
  if (next === 'de') {
    try {
      const response = await fetch('/locale/de.json');
      messages = response.ok ? await response.json() : {};
    } catch {
      messages = {};
    }
  } else {
    messages = {};
  }
  language = next;
  document.documentElement.lang = next;
  localStorage.setItem(STORAGE_KEY, next);
}

export async function initLanguage(): Promise<void> {
  const stored = localStorage.getItem(STORAGE_KEY);
  const wanted = stored === 'de' || stored === 'en' ? stored : navigator.language.startsWith('de') ? 'de' : 'en';
  await setLanguage(wanted);
}
