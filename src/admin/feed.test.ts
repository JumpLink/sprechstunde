import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FeedError, parseFeed, renderFeed } from './feed.js';

// Invented venue; the dates are chosen so the clock below sits inside the summer season.
const base = {
  version: 1,
  timeZone: 'Europe/Berlin',
  inLanguage: 'en',
  name: 'Harbour Kitchen',
  description: 'A small restaurant by the water.',
  address: {
    streetAddress: '1 Quay Road',
    postalCode: '12345',
    addressLocality: 'Seaton',
  },
  openingHoursSpecification: [
    {
      name: 'Kitchen',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      opens: '17:00',
      closes: '21:00',
      validFrom: '2026-11-01',
      validThrough: '2027-03-28',
    },
    {
      name: 'Kitchen',
      dayOfWeek: ['Saturday', 'Sunday'],
      opens: '12:00',
      closes: '21:00',
      validFrom: '2026-11-01',
      validThrough: '2027-03-28',
    },
    {
      dayOfWeek: WEEK(),
      opens: '12:00',
      closes: '21:00',
      validFrom: '2026-03-29',
      validThrough: '2026-10-31',
    },
  ],
  specialOpeningHoursSpecification: [
    {
      name: 'Christmas Eve',
      opens: '09:00',
      closes: '11:30',
      validFrom: '2026-12-24',
      validThrough: '2026-12-24',
      description: 'breakfast only',
    },
    {
      name: 'Staff outing',
      opens: '00:00',
      closes: '00:00',
      validFrom: '2026-09-01',
      validThrough: '2026-09-01',
    },
  ],
  hasMenu: [
    {
      name: 'Autumn card',
      description: 'Seasonal dishes with game and mushrooms.',
      validFrom: '2026-10-01',
      validThrough: '2026-11-30',
      hasMenuSection: [
        {
          name: 'Mains',
          hasMenuItem: [
            {
              name: 'Venison stew',
              description: 'with red cabbage',
              offers: { price: 18.5, priceCurrency: 'EUR' },
            },
          ],
        },
      ],
    },
    {
      name: 'Summer card',
      description: 'Light dishes.',
      validFrom: '2026-05-01',
      validThrough: '2026-09-30',
    },
    { name: 'Spring card', description: 'Not yet.', validFrom: '2027-03-01' },
  ],
  faq: [
    { name: 'Are dogs welcome?', acceptedAnswer: { text: 'Yes, on a lead.' } },
    {
      name: 'Internal question',
      acceptedAnswer: { text: 'Staff only.' },
      assistantMaySay: false,
    },
  ],
};

function WEEK(): string[] {
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
}

const parts = (feed: unknown, at: string) => renderFeed(parseFeed(JSON.stringify(feed)), new Date(at));
const rejects = (feed: unknown, pattern: RegExp) =>
  assert.throws(
    () => parseFeed(typeof feed === 'string' ? feed : JSON.stringify(feed)),
    (e) => e instanceof FeedError && pattern.test(e.message),
  );

test('a menu outside its window is left out; the card of the day is written with its validity', () => {
  const found = parts(base, '2026-11-10T10:00:00Z');
  assert.deepEqual(
    found.map((part) => part.anchor),
    ['about', 'hours', 'menu-1', 'faq'],
  );
  const menu = found.find((part) => part.anchor === 'menu-1')!;
  assert.match(menu.markdown, /Valid: October 1 – November 30/);
  assert.match(menu.markdown, /Seasonal dishes with game and mushrooms\./);
  assert.match(menu.markdown, /- Venison stew – with red cabbage, €18\.50/);
});

test('menu anchors follow the position in the feed, so they survive an earlier expiry', () => {
  const found = parts(base, '2026-07-01T10:00:00Z');
  assert.deepEqual(
    found.filter((part) => part.anchor.startsWith('menu')).map((part) => part.anchor),
    ['menu-2'],
  );
});

test('the day is read in the time zone of the feed', () => {
  // 23:30 UTC on 30 Nov is already 1 Dec in Berlin: the autumn card is over there.
  assert.ok(parts(base, '2026-11-30T22:30:00Z').some((part) => part.anchor === 'menu-1'));
  assert.ok(!parts(base, '2026-11-30T23:30:00Z').some((part) => part.anchor === 'menu-1'));
});

test('hours: a season that is over is dropped, one that is ahead is kept with its dates', () => {
  const hours = parts(base, '2026-11-10T10:00:00Z').find((part) => part.anchor === 'hours')!.markdown;
  assert.doesNotMatch(hours, /March 29/);
  assert.match(hours, /### November 1, 2026 – March 28, 2027/);
  assert.match(hours, /- Kitchen, Monday – Friday: 17:00–21:00/);
  assert.match(hours, /- Kitchen, Saturday, Sunday: 12:00–21:00/);
  assert.match(hours, /### Exception: Christmas Eve \(December 24\)\n- 09:00–11:30 \(breakfast only\)/);
  assert.doesNotMatch(hours, /Staff outing/);
  assert.match(hours, /An exception applies instead of the regular hours\./);
});

test('hours: a spring season ahead of the date is written with its start', () => {
  const hours = parts(base, '2026-02-01T10:00:00Z').find((part) => part.anchor === 'hours')!.markdown;
  assert.match(hours, /### March 29 – October 31\n- Daily: 12:00–21:00/);
});

test('a closed exception is written as closed', () => {
  const hours = parts(base, '2026-08-20T10:00:00Z').find((part) => part.anchor === 'hours')!.markdown;
  assert.match(hours, /### Exception: Staff outing \(September 1\)\n- closed/);
});

test('exception entries for the same occasion and period share one heading', () => {
  const feed = {
    ...base,
    specialOpeningHoursSpecification: [
      {
        name: 'Christmas Eve',
        description: 'breakfast',
        opens: '09:00',
        closes: '11:30',
        validFrom: '2026-12-24',
        validThrough: '2026-12-24',
      },
      {
        name: 'Christmas Eve',
        description: 'kitchen',
        opens: '00:00',
        closes: '00:00',
        validFrom: '2026-12-24',
        validThrough: '2026-12-24',
      },
    ],
  };
  const hours = parts(feed, '2026-11-10T10:00:00Z').find((part) => part.anchor === 'hours')!.markdown;
  assert.match(
    hours,
    /### Exception: Christmas Eve \(December 24\)\n- 09:00–11:30 \(breakfast\)\n- closed \(kitchen\)/,
  );
  assert.equal(hours.match(/### Exception/g)?.length, 1);
});

test('German feeds get German headings, weekdays and prices', () => {
  const found = parts({ ...base, inLanguage: 'de' }, '2026-11-10T10:00:00Z');
  const hours = found.find((part) => part.anchor === 'hours')!;
  assert.equal(hours.title, 'Öffnungszeiten');
  assert.match(hours.markdown, /Montag – Freitag: 17:00–21:00/);
  assert.match(hours.markdown, /1\. November 2026 – 28\. März 2027/);
  assert.match(found.find((part) => part.anchor === 'menu-1')!.markdown, /18,50\s€/);
  assert.match(found.find((part) => part.anchor === 'menu-1')!.markdown, /Gültig: 1\. Oktober – 30\. November/);
});

test('a language without labels reads English', () => {
  const found = parts({ ...base, inLanguage: 'fr' }, '2026-11-10T10:00:00Z');
  assert.equal(found.find((part) => part.anchor === 'hours')!.title, 'Opening hours');
});

test('the FAQ keeps what the assistant may say and drops the rest', () => {
  const faq = parts(base, '2026-11-10T10:00:00Z').find((part) => part.anchor === 'faq')!.markdown;
  assert.match(faq, /Are dogs welcome\?\nYes, on a lead\./);
  assert.doesNotMatch(faq, /Staff only/);
});

test('a feed with nothing valid yields no parts', () => {
  assert.deepEqual(parts({ version: 1, timeZone: 'Europe/Berlin' }, '2026-11-10T10:00:00Z'), []);
});

test('a menu needs a description for the assistant', () => {
  rejects({ version: 1, timeZone: 'UTC', hasMenu: [{ name: 'Card' }] }, /\$\.hasMenu\[0\]\.description/);
  rejects(
    {
      version: 1,
      timeZone: 'UTC',
      hasMenu: [{ name: 'Card', description: '   ' }],
    },
    /\$\.hasMenu\[0\]\.description/,
  );
});

test('the time zone is required and must exist', () => {
  rejects({ version: 1 }, /\$\.timeZone/);
  rejects({ version: 1, timeZone: 'Mars/Olympus' }, /\$\.timeZone/);
});

test('the version must be 1', () => {
  rejects({ version: 2, timeZone: 'UTC' }, /\$\.version/);
  rejects({ timeZone: 'UTC' }, /version/);
});

test('bad input is named by its path', () => {
  rejects('{ nope', /JSON/);
  rejects('[]', /\$/);
  rejects(
    {
      version: 1,
      timeZone: 'UTC',
      openingHoursSpecification: [{ dayOfWeek: 'Funday', opens: '09:00', closes: '10:00' }],
    },
    /openingHoursSpecification\[0\]\.dayOfWeek\[0\]/,
  );
  rejects(
    {
      version: 1,
      timeZone: 'UTC',
      openingHoursSpecification: [{ opens: '9:00', closes: '10:00' }],
    },
    /\.opens/,
  );
  rejects(
    {
      version: 1,
      timeZone: 'UTC',
      openingHoursSpecification: [{ opens: '09:00', closes: '10:00', validFrom: '2026-02-30' }],
    },
    /\.validFrom/,
  );
  rejects(
    {
      version: 1,
      timeZone: 'UTC',
      openingHoursSpecification: [
        {
          opens: '09:00',
          closes: '10:00',
          validFrom: '2026-05-02',
          validThrough: '2026-05-01',
        },
      ],
    },
    /\.validThrough/,
  );
  rejects(
    {
      version: 1,
      timeZone: 'UTC',
      specialOpeningHoursSpecification: [{ opens: '09:00', closes: '10:00' }],
    },
    /\.validFrom/,
  );
  rejects(
    {
      version: 1,
      timeZone: 'UTC',
      hasMenu: [
        {
          name: 'C',
          description: 'd',
          hasMenuSection: [
            {
              name: 'S',
              hasMenuItem: [{ name: 'I', offers: { price: 'free', priceCurrency: 'EUR' } }],
            },
          ],
        },
      ],
    },
    /\.price/,
  );
  rejects({ version: 1, timeZone: 'UTC', faq: [{ name: 'Q' }] }, /\.acceptedAnswer/);
});

test('schema.org weekday addresses are accepted', () => {
  const feed = parseFeed(
    JSON.stringify({
      version: 1,
      timeZone: 'UTC',
      openingHoursSpecification: [
        {
          dayOfWeek: 'https://schema.org/Monday',
          opens: '09:00',
          closes: '24:00',
        },
      ],
    }),
  );
  assert.deepEqual(feed.hours[0]!.days, [0]);
  assert.equal(feed.hours[0]!.closes, '24:00');
});

test('an opening time without a day means every day', () => {
  const found = parts(
    {
      version: 1,
      timeZone: 'UTC',
      openingHoursSpecification: [{ opens: '09:00', closes: '10:00' }],
    },
    '2026-11-10T10:00:00Z',
  );
  assert.match(found[0]!.markdown, /### All year\n- Daily: 09:00–10:00/);
});

test('too many entries are refused', () => {
  rejects(
    {
      version: 1,
      timeZone: 'UTC',
      faq: Array.from({ length: 201 }, () => ({})),
    },
    /\$\.faq/,
  );
});

test('the example feed in the docs is valid', () => {
  const text = readFileSync(new URL('../../docs/feed/example.json', import.meta.url), 'utf8');
  const found = renderFeed(parseFeed(text), new Date('2026-11-10T10:00:00Z'));
  assert.deepEqual(
    found.map((part) => part.anchor),
    ['about', 'hours', 'menu-1', 'faq'],
  );
});
