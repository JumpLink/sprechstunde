/**
 * Writes digits out as German words before text goes to a voice that cannot read them.
 *
 * Kyutai Pocket TTS dropped the number in "19:00 Uhr", "4 Personen" or "ab 17 Uhr" in almost every
 * run (measured 2026-10-19, read back with Mistral STT); written out as words, every sentence came
 * through whole. Covers what a venue's assistant says: times, dates, prices, percentages, ranges,
 * phone numbers and plain counts. Anything else is left as it is.
 */

const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'];
const TEENS = [
  'zehn',
  'elf',
  'zwölf',
  'dreizehn',
  'vierzehn',
  'fünfzehn',
  'sechzehn',
  'siebzehn',
  'achtzehn',
  'neunzehn',
];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
// "1 Person" is "eine Person"; for every other noun "ein" is close enough on the phone.
const FEMININE = /^(Person|Stunde|Minute|Nacht|Woche|Flasche|Portion|Kugel|Etage|Nummer)\b/;

function below100(n: number): string {
  if (n < 10) return ONES[n]!;
  if (n < 20) return TEENS[n - 10]!;
  const ones = n % 10;
  const tens = TENS[Math.floor(n / 10)]!;
  return ones === 0 ? tens : `${ones === 1 ? 'ein' : ONES[ones]}und${tens}`;
}

function below1000(n: number): string {
  if (n < 100) return below100(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return `${hundreds === 1 ? '' : ONES[hundreds]}hundert${rest ? below100(rest) : ''}`;
}

/** Cardinal number, e.g. 21 → "einundzwanzig". Up to 999 999 999; larger numbers stay digits. */
export function germanCardinal(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e9) return String(n);
  if (n < 1000) return below1000(n);
  if (n < 1e6) {
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    return `${thousands === 1 ? '' : below1000(thousands).replace(/eins$/, 'ein')}tausend${rest ? below1000(rest) : ''}`;
  }
  const millions = Math.floor(n / 1e6);
  const rest = n % 1e6;
  const head = millions === 1 ? 'eine Million' : `${below1000(millions).replace(/eins$/, 'ein')} Millionen`;
  return rest ? `${head} ${germanCardinal(rest)}` : head;
}

/** "Ein Uhr", "ein Euro": the counting form "eins" only stands alone. */
function attributive(n: number): string {
  return germanCardinal(n).replace(/eins$/, 'ein');
}

/** Year as spoken: 1999 → "neunzehnhundertneunundneunzig", 2026 → "zweitausendsechsundzwanzig". */
function germanYear(n: number): string {
  if (n >= 1100 && n < 2000) {
    const rest = n % 100;
    return `${below100(Math.floor(n / 100))}hundert${rest ? below100(rest) : ''}`;
  }
  return germanCardinal(n);
}

/** Ordinal stem with ending, e.g. (3, "ten") → "dritten", (20, "te") → "zwanzigste". */
function germanOrdinal(n: number, ending: 'te' | 'ten'): string {
  const special: Record<number, string> = { 1: 'ers', 3: 'drit', 7: 'sieb', 8: 'ach' };
  if (n < 20) return `${special[n] ?? germanCardinal(n)}${ending}`;
  return `${germanCardinal(n)}s${ending}`;
}

/** Digit by digit, with a short pause between the groups the text already has. */
function spellDigits(raw: string): string {
  const groups = raw
    .trim()
    .split(/[\s/-]+/)
    .filter(Boolean);
  return groups
    .map((group) =>
      group
        .replace(/^\+/, 'plus ')
        .replace(/\d/g, (d) => ` ${d === '2' ? 'zwo' : ONES[Number(d)]}`)
        .trim()
        .replace(/\s+/g, ' '),
    )
    .join(', ');
}

function decimal(intPart: string, fraction: string): string {
  return `${germanCardinal(Number(intPart))} Komma ${[...fraction].map((d) => ONES[Number(d)]).join(' ')}`;
}

/** Dative after these words: "am zwölften Oktober", otherwise "der zwölfte Oktober". */
function ordinalEnding(before: string): 'te' | 'ten' {
  return /\b(am|vom|zum|bis zum|ab dem|dem|den|seit dem)\s*$/i.test(before) ? 'ten' : 'te';
}

/** German `text` with digits written out; other characters are untouched. */
export function spellOutNumbersDe(text: string): string {
  let out = text;

  // Phone numbers first, before the parts of them look like anything else: 6+ digits in groups.
  out = out.replace(/(?<![\d,.:])\+?\d[\d /-]{4,}\d(?![\d,.:])/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 6) return match;
    // A plain number written with spaces as thousands separators ("12 500") is not a phone number.
    if (/^\d{1,3}( \d{3})+$/.test(match)) return match.replace(/ /g, '');
    return spellDigits(match);
  });

  // Times: "19:00 Uhr" → "neunzehn Uhr", "19:30" → "neunzehn Uhr dreißig".
  out = out.replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(\s*Uhr\b)?/g, (match, h: string, m: string, uhr?: string) => {
    // "1.50" without "Uhr" is more likely a price or a decimal than a time.
    if (match.includes('.') && !uhr) return match;
    const minutes = Number(m);
    return `${attributive(Number(h))} Uhr${minutes ? ` ${germanCardinal(minutes)}` : ''}`;
  });

  // Dates: "12.10." / "12.10.2026" → "zwölfte Zehnte (zweitausendsechsundzwanzig)".
  out = out.replace(
    /(^|[^\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?!\d)/g,
    (match, lead: string, d: string, m: string, y: string | undefined, offset: number) => {
      const day = Number(d);
      const month = Number(m);
      if (day < 1 || day > 31 || month < 1 || month > 12) return match;
      const ending = ordinalEnding(out.slice(0, offset) + lead);
      const year = y ? ` ${germanYear(Number(y.length === 2 ? `20${y}` : y))}` : '';
      return `${lead}${germanOrdinal(day, ending)} ${germanOrdinal(month, ending).replace(/^./, (c) => c.toUpperCase())}${year}`;
    },
  );
  // "12. Oktober" → "zwölfte Oktober" / "am zwölften Oktober".
  out = out.replace(
    new RegExp(`(^|[^\\d.])(\\d{1,2})\\.\\s+(${MONTHS.join('|')})`, 'g'),
    (match, lead: string, d: string, month: string, offset: number) => {
      const day = Number(d);
      if (day < 1 || day > 31) return match;
      return `${lead}${germanOrdinal(day, ordinalEnding(out.slice(0, offset) + lead))} ${month}`;
    },
  );

  // Thousands separators: "1.500" → "1500".
  out = out.replace(/\b\d{1,3}(?:\.\d{3})+\b(?![.,]\d)/g, (match) => match.replace(/\./g, ''));

  // Prices: "12,50 €" → "zwölf Euro fünfzig", "€ 8" → "acht Euro".
  out = out.replace(
    /(?:€\s*(\d+)(?:,(\d{1,2}))?|\b(\d+)(?:,(\d{1,2}|-))?\s*(?:€|Euro\b|EUR\b))/g,
    (_m, a?: string, ac?: string, b?: string, bc?: string) => {
      const euros = Number(a ?? b);
      const cents = Number((ac ?? bc ?? '').replace('-', '').padEnd(2, '0') || 0);
      return `${attributive(euros)} Euro${cents ? ` ${germanCardinal(cents)}` : ''}`;
    },
  );

  // Percent and decimals: "2,5 %" → "zwei Komma fünf Prozent".
  out = out.replace(/\b(\d+)(?:,(\d+))?\s*%/g, (_m, i: string, f?: string) =>
    f ? `${decimal(i, f)} Prozent` : `${germanCardinal(Number(i))} Prozent`,
  );
  out = out.replace(/\b(\d+),(\d+)\b/g, (_m, i: string, f: string) => decimal(i, f));

  // Ranges: "17–22 Uhr" → "17 bis 22 Uhr" (the numbers follow below).
  out = out.replace(/\b(\d{1,4})\s*[–-]\s*(\d{1,4})\b/g, '$1 bis $2');

  // Plain numbers. 1100–1999 is read as a year after "seit", "im" or with no noun following.
  out = out.replace(/\b\d+\b/g, (match, offset: number) => {
    const n = Number(match);
    const after = out.slice(offset + match.length).trimStart();
    const before = out.slice(0, offset);
    if (n >= 1100 && n < 2000 && (/\b(seit|Jahr|anno|im)\s*$/i.test(before) || !/^\p{L}/u.test(after))) {
      return germanYear(n);
    }
    if (n === 1) {
      if (FEMININE.test(after)) return 'eine';
      if (/^\p{Lu}/u.test(after) || /^Uhr\b/.test(after)) return 'ein';
    }
    return germanCardinal(n);
  });

  return out;
}

/** The spell-out for `locale`'s language; text in a language without one passes through. */
export function spellOutNumbers(locale: string): ((text: string) => string) | undefined {
  return locale.toLowerCase().startsWith('de') ? spellOutNumbersDe : undefined;
}
