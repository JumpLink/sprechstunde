/**
 * The knowledge feed (ADR 2): one JSON document a venue publishes, in schema.org vocabulary, that
 * sprechstunde fetches and turns into sections of the venue's knowledge. `parseFeed` is the one
 * definition of the format (docs/feed/README.md describes it); `renderFeed` writes what is valid
 * today as Markdown, one part per kind of knowledge.
 *
 * Pure: no network, no clock of its own. The caller passes `now`.
 */

import { _ } from '../i18n.js';

export class FeedError extends Error {}

export interface FeedPart {
  /** The fragment that tells parts of one feed apart: `<feed address>#<anchor>`. */
  anchor: string;
  title: string;
  markdown: string;
}

interface Hours {
  name?: string;
  description?: string;
  /** 0 = Monday … 6 = Sunday; null on an exception that applies to every day of its period. */
  days: number[] | null;
  opens: string;
  closes: string;
  validFrom?: string;
  validThrough?: string;
}

interface MenuItem {
  name: string;
  description?: string;
  price?: { amount: number; currency: string };
}

interface MenuSection {
  name: string;
  description?: string;
  items: MenuItem[];
}

interface Menu {
  /** Position in the feed, so the anchor stays the same when an earlier menu expires. */
  index: number;
  name: string;
  description: string;
  validFrom?: string;
  validThrough?: string;
  sections: MenuSection[];
}

export interface Feed {
  timeZone: string;
  language: string;
  name?: string;
  description?: string;
  url?: string;
  address?: string;
  hours: Hours[];
  exceptions: Hours[];
  menus: Menu[];
  faq: Array<{ question: string; answer: string }>;
}

const MAX_LINE = 200;
const MAX_TEXT = 4000;
const MAX_HOURS = 200;
const MAX_MENUS = 50;
const MAX_SECTIONS = 50;
const MAX_ITEMS = 200;
const MAX_FAQ = 200;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type Json = Record<string, unknown>;

const fail = (message: string, path: string): never => {
  throw new FeedError(message.replace('%s', () => path));
};

function record(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(_('"%s" must be an object'), path);
  }
  return value as Json;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail(_('"%s" must be a list'), path);
  if (value.length > max) return fail(_('"%s" has too many entries'), path);
  return value;
}

/** One line of text, or undefined when absent or blank. */
function line(value: unknown, path: string, max = MAX_LINE): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return fail(_('"%s" must be text'), path);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) return fail(_('"%s" is too long'), path);
  return text === '' ? undefined : text;
}

/** Running text; line breaks stay. */
function block(value: unknown, path: string, max = MAX_TEXT): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return fail(_('"%s" must be text'), path);
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > max) return fail(_('"%s" is too long'), path);
  return text === '' ? undefined : text;
}

const required = <T>(value: T | undefined, path: string): T =>
  value === undefined ? fail(_('"%s" is missing'), path) : value;

function date(value: unknown, path: string): string | undefined {
  const text = line(value, path, 10);
  if (text === undefined) return undefined;
  const parsed = new Date(`${text}T00:00:00Z`);
  const real =
    /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
  return real ? text : fail(_('"%s" must be a date such as 2026-04-05'), path);
}

function time(value: unknown, path: string, isEnd: boolean): string {
  const text = required(line(value, path, 5), path);
  const ok = /^([01]\d|2[0-3]):[0-5]\d$/.test(text) || (isEnd && text === '24:00');
  return ok ? text : fail(_('"%s" must be a time such as 17:30'), path);
}

function weekdays(value: unknown, path: string): number[] | null {
  if (value === undefined || value === null) return null;
  const given = Array.isArray(value) ? value : [value];
  if (given.length === 0 || given.length > 7) return fail(_('"%s" is not a weekday'), path);
  const days = given.map((entry, at) => {
    const name = typeof entry === 'string' ? entry.replace(/^https?:\/\/schema\.org\//, '') : '';
    const day = WEEKDAYS.indexOf(name);
    return day >= 0 ? day : fail(_('"%s" is not a weekday'), `${path}[${at}]`);
  });
  return [...new Set(days)].sort((a, b) => a - b);
}

function period(from: unknown, through: unknown, path: string): { validFrom?: string; validThrough?: string } {
  const validFrom = date(from, `${path}.validFrom`);
  const validThrough = date(through, `${path}.validThrough`);
  if (validFrom && validThrough && validThrough < validFrom) {
    return fail(_('"%s" ends before it starts'), `${path}.validThrough`);
  }
  return {
    ...(validFrom && { validFrom }),
    ...(validThrough && { validThrough }),
  };
}

function hours(value: unknown, path: string, exception: boolean): Hours {
  const o = record(value, path);
  const when = period(o.validFrom, o.validThrough, path);
  if (exception) {
    required(when.validFrom, `${path}.validFrom`);
    required(when.validThrough, `${path}.validThrough`);
  }
  const days = weekdays(o.dayOfWeek, `${path}.dayOfWeek`);
  const name = line(o.name, `${path}.name`);
  const description = line(o.description, `${path}.description`);
  return {
    ...(name && { name }),
    ...(description && { description }),
    days: days ?? (exception ? null : [0, 1, 2, 3, 4, 5, 6]),
    opens: time(o.opens, `${path}.opens`, false),
    closes: time(o.closes, `${path}.closes`, true),
    ...when,
  };
}

function price(value: unknown, path: string): MenuItem['price'] {
  if (value === undefined || value === null) return undefined;
  const o = record(value, path);
  const amount = typeof o.price === 'string' ? Number(o.price.replace(',', '.')) : o.price;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return fail(_('"%s" must be an amount'), `${path}.price`);
  }
  const currency = line(o.priceCurrency, `${path}.priceCurrency`, 3);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return fail(_('"%s" must be a currency code such as EUR'), `${path}.priceCurrency`);
  }
  return { amount, currency };
}

function menu(value: unknown, path: string, index: number): Menu {
  const o = record(value, path);
  const sections = list(o.hasMenuSection, `${path}.hasMenuSection`, MAX_SECTIONS).map((entry, at): MenuSection => {
    const where = `${path}.hasMenuSection[${at}]`;
    const s = record(entry, where);
    const description = block(s.description, `${where}.description`);
    return {
      name: required(line(s.name, `${where}.name`), `${where}.name`),
      ...(description && { description }),
      items: list(s.hasMenuItem, `${where}.hasMenuItem`, MAX_ITEMS).map((item, n): MenuItem => {
        const p = `${where}.hasMenuItem[${n}]`;
        const i = record(item, p);
        const text = block(i.description, `${p}.description`, MAX_LINE * 5);
        const cost = price(i.offers, `${p}.offers`);
        return {
          name: required(line(i.name, `${p}.name`), `${p}.name`),
          ...(text && { description: text }),
          ...(cost && { price: cost }),
        };
      }),
    };
  });
  return {
    index,
    name: required(line(o.name, `${path}.name`), `${path}.name`),
    description: required(block(o.description, `${path}.description`), `${path}.description`),
    ...period(o.validFrom, o.validThrough, path),
    sections,
  };
}

function address(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const o = record(value, path);
  const street = line(o.streetAddress, `${path}.streetAddress`);
  const town = [line(o.postalCode, `${path}.postalCode`, 20), line(o.addressLocality, `${path}.addressLocality`)]
    .filter(Boolean)
    .join(' ');
  return [street, town].filter(Boolean).join(', ') || undefined;
}

/** Checks a feed document and returns it in the shape `renderFeed` reads. Throws `FeedError`. */
export function parseFeed(text: string): Feed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FeedError(_('the feed is not valid JSON'));
  }
  const o = record(raw, '$');
  if (o.version !== 1) return fail(_('"%s" must be 1: this version of the feed is not supported'), '$.version');

  const timeZone = required(line(o.timeZone, '$.timeZone', 64), '$.timeZone');
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    return fail(_('"%s" is not a known time zone'), '$.timeZone');
  }
  const language = line(o.inLanguage, '$.inLanguage', 35) ?? 'en';
  try {
    Intl.getCanonicalLocales(language);
  } catch {
    return fail(_('"%s" is not a language tag'), '$.inLanguage');
  }

  const name = line(o.name, '$.name');
  const description = block(o.description, '$.description');
  const url = line(o.url, '$.url', 500);
  const where = address(o.address, '$.address');
  return {
    timeZone,
    language,
    ...(name && { name }),
    ...(description && { description }),
    ...(url && { url }),
    ...(where && { address: where }),
    hours: list(o.openingHoursSpecification, '$.openingHoursSpecification', MAX_HOURS).map((entry, at) =>
      hours(entry, `$.openingHoursSpecification[${at}]`, false),
    ),
    exceptions: list(o.specialOpeningHoursSpecification, '$.specialOpeningHoursSpecification', MAX_HOURS).map(
      (entry, at) => hours(entry, `$.specialOpeningHoursSpecification[${at}]`, true),
    ),
    menus: list(o.hasMenu, '$.hasMenu', MAX_MENUS).map((entry, at) => menu(entry, `$.hasMenu[${at}]`, at)),
    faq: list(o.faq, '$.faq', MAX_FAQ).flatMap((entry, at) => {
      const path = `$.faq[${at}]`;
      const q = record(entry, path);
      // Default is that the assistant may say it; a venue marks the exceptions.
      if (q.assistantMaySay === false) return [];
      const answer = record(q.acceptedAnswer, `${path}.acceptedAnswer`);
      return [
        {
          question: required(line(q.name, `${path}.name`), `${path}.name`),
          answer: required(block(answer.text, `${path}.acceptedAnswer.text`), `${path}.acceptedAnswer.text`),
        },
      ];
    }),
  };
}

// Headings and joining words for the assistant's text, in the language of the feed. They are knowledge
// the model reads, not interface text, so they stay out of gettext; an unknown language reads English.
interface Labels {
  about: string;
  address: string;
  always: string;
  closed: string;
  daily: string;
  exception: string;
  faq: string;
  from: string;
  hours: string;
  precedence: string;
  until: string;
  valid: string;
}

const LABELS: Record<string, Labels> = {
  en: {
    about: 'About',
    address: 'Address',
    always: 'All year',
    closed: 'closed',
    daily: 'Daily',
    exception: 'Exception',
    faq: 'Frequently asked questions',
    from: 'from',
    hours: 'Opening hours',
    precedence: 'An exception applies instead of the regular hours.',
    until: 'until',
    valid: 'Valid',
  },
  de: {
    about: 'Über uns',
    address: 'Adresse',
    always: 'Ganzjährig',
    closed: 'geschlossen',
    daily: 'Täglich',
    exception: 'Ausnahme',
    faq: 'Häufige Fragen',
    from: 'ab',
    hours: 'Öffnungszeiten',
    precedence: 'Eine Ausnahme gilt anstelle der regulären Zeiten.',
    until: 'bis',
    valid: 'Gültig',
  },
};

/** Today's date in the feed's time zone, as `YYYY-MM-DD`. */
function today(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function renderFeed(feed: Feed, now: Date): FeedPart[] {
  const l = LABELS[feed.language.split('-')[0]!.toLowerCase()] ?? LABELS.en!;
  const day = today(now, feed.timeZone);
  const thisYear = day.slice(0, 4);

  const dateText = (value: string, withYear: boolean): string =>
    new Intl.DateTimeFormat(feed.language, {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'long',
      ...(withYear && { year: 'numeric' }),
    }).format(new Date(`${value}T12:00:00Z`));

  const spanText = (from?: string, through?: string): string => {
    const withYear = [from, through].some((value) => value !== undefined && value.slice(0, 4) !== thisYear);
    if (from && through) {
      return from === through
        ? dateText(from, withYear)
        : `${dateText(from, withYear)} – ${dateText(through, withYear)}`;
    }
    if (from) return `${l.from} ${dateText(from, withYear)}`;
    if (through) return `${l.until} ${dateText(through, withYear)}`;
    return '';
  };

  const weekdayName = (index: number): string =>
    new Intl.DateTimeFormat(feed.language, {
      weekday: 'long',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2024, 0, 1 + index, 12)));

  /** `Monday – Friday, Sunday`: runs of three or more days are written as a range. */
  const daysText = (days: number[]): string => {
    if (days.length === 7) return l.daily;
    const runs: number[][] = [];
    for (const d of days) {
      const last = runs.at(-1);
      if (last && last.at(-1) === d - 1) last.push(d);
      else runs.push([d]);
    }
    return runs
      .map((run) =>
        run.length >= 3 ? `${weekdayName(run[0]!)} – ${weekdayName(run.at(-1)!)}` : run.map(weekdayName).join(', '),
      )
      .join(', ');
  };

  const money = (cost: { amount: number; currency: string }): string =>
    new Intl.NumberFormat(feed.language, {
      style: 'currency',
      currency: cost.currency,
    }).format(cost.amount);

  const valid = (entry: { validFrom?: string; validThrough?: string }): boolean =>
    !(entry.validFrom && entry.validFrom > day) && !(entry.validThrough && entry.validThrough < day);
  const notOver = (entry: { validThrough?: string }): boolean => !(entry.validThrough && entry.validThrough < day);

  const hoursLine = (entry: Hours): string => {
    const times = entry.opens === '00:00' && entry.closes === '00:00' ? l.closed : `${entry.opens}–${entry.closes}`;
    const subject = [entry.name, entry.days && daysText(entry.days)].filter(Boolean).join(', ');
    return `- ${subject ? `${subject}: ` : ''}${times}${entry.description ? ` (${entry.description})` : ''}`;
  };

  const parts: FeedPart[] = [];

  const about = [
    feed.name && `## ${feed.name}`,
    feed.description,
    feed.address && `${l.address}: ${feed.address}`,
    feed.url,
  ].filter(Boolean);
  if (about.length > 0)
    parts.push({
      anchor: 'about',
      title: l.about,
      markdown: about.join('\n\n'),
    });

  // Seasons still ahead stay, with their dates written out; only what is over leaves.
  const regular = feed.hours.filter(notOver);
  const exceptions = feed.exceptions.filter(notOver);
  if (regular.length + exceptions.length > 0) {
    const out: string[] = [`## ${l.hours}`];
    if (exceptions.length > 0) out.push(l.precedence);
    const groups = new Map<string, Hours[]>();
    for (const entry of regular) {
      const key = JSON.stringify([entry.validFrom, entry.validThrough]);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      const heading = spanText(group[0]!.validFrom, group[0]!.validThrough) || l.always;
      out.push(`### ${heading}\n${group.map(hoursLine).join('\n')}`);
    }
    for (const entry of exceptions) {
      const span = spanText(entry.validFrom, entry.validThrough);
      const heading = entry.name ? `${entry.name} (${span})` : span;
      out.push(`### ${l.exception}: ${heading}\n${hoursLine({ ...entry, name: undefined })}`);
    }
    parts.push({ anchor: 'hours', title: l.hours, markdown: out.join('\n\n') });
  }

  // A menu outside its window is not written at all, so the assistant cannot offer an old card.
  for (const entry of feed.menus.filter(valid)) {
    const out: string[] = [`## ${entry.name}`];
    const span = spanText(entry.validFrom, entry.validThrough);
    if (span) out.push(`${l.valid}: ${span}`);
    out.push(entry.description);
    for (const section of entry.sections) {
      const items = section.items.map(
        (item) =>
          `- ${item.name}${item.description ? ` – ${item.description}` : ''}${item.price ? `, ${money(item.price)}` : ''}`,
      );
      out.push([`### ${section.name}`, section.description, items.join('\n')].filter(Boolean).join('\n'));
    }
    parts.push({
      anchor: `menu-${entry.index + 1}`,
      title: entry.name,
      markdown: out.join('\n\n'),
    });
  }

  if (feed.faq.length > 0) {
    const out = [`## ${l.faq}`, ...feed.faq.map((entry) => `### ${entry.question}\n${entry.answer}`)];
    parts.push({ anchor: 'faq', title: l.faq, markdown: out.join('\n\n') });
  }

  return parts;
}
