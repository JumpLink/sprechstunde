import assert from 'node:assert/strict';
import { test } from 'node:test';
import { germanCardinal, spellOutNumbers, spellOutNumbersDe as say } from './spoken-numbers.js';

test('germanCardinal', () => {
  const cases: [number, string][] = [
    [0, 'null'],
    [1, 'eins'],
    [16, 'sechzehn'],
    [17, 'siebzehn'],
    [21, 'einundzwanzig'],
    [30, 'dreißig'],
    [100, 'hundert'],
    [101, 'hunderteins'],
    [999, 'neunhundertneunundneunzig'],
    [1000, 'tausend'],
    [1001, 'tausendeins'],
    [21000, 'einundzwanzigtausend'],
    [2026, 'zweitausendsechsundzwanzig'],
    [1000000, 'eine Million'],
    [3000005, 'drei Millionen fünf'],
  ];
  for (const [n, words] of cases) assert.equal(germanCardinal(n), words, String(n));
});

test('times', () => {
  assert.equal(say('Am Samstag um 19:00 Uhr.'), 'Am Samstag um neunzehn Uhr.');
  assert.equal(say('um 19:30'), 'um neunzehn Uhr dreißig');
  assert.equal(say('um 1:00 Uhr'), 'um ein Uhr');
  assert.equal(say('ab 17.30 Uhr'), 'ab siebzehn Uhr dreißig');
  assert.equal(say('ab 17 Uhr geöffnet'), 'ab siebzehn Uhr geöffnet');
  assert.equal(say('von 17–22 Uhr'), 'von siebzehn bis zweiundzwanzig Uhr');
});

test('counts', () => {
  assert.equal(say('einen Tisch für 4 Personen'), 'einen Tisch für vier Personen');
  assert.equal(say('für 1 Person'), 'für eine Person');
  assert.equal(say('Sie sind Nummer 1.'), 'Sie sind Nummer eins.');
  assert.equal(say('1.500 Gäste'), 'tausendfünfhundert Gäste');
});

test('dates', () => {
  assert.equal(say('am 12.10.'), 'am zwölften Zehnten');
  assert.equal(say('der 3.11.2026'), 'der dritte Elfte zweitausendsechsundzwanzig');
  assert.equal(say('am 1. Mai'), 'am ersten Mai');
  assert.equal(say('Heute ist der 24. Dezember'), 'Heute ist der vierundzwanzigste Dezember');
  assert.equal(say('seit 1998'), 'seit neunzehnhundertachtundneunzig');
});

test('prices, percent, decimals', () => {
  assert.equal(say('kostet 12,50 €'), 'kostet zwölf Euro fünfzig');
  assert.equal(say('kostet 8 Euro'), 'kostet acht Euro');
  assert.equal(say('kostet 1 €'), 'kostet ein Euro');
  assert.equal(say('10 % Rabatt'), 'zehn Prozent Rabatt');
  assert.equal(say('2,5 km'), 'zwei Komma fünf km');
});

test('phone numbers digit by digit', () => {
  assert.equal(say('unter 0421 123456'), 'unter null vier zwo eins, eins zwo drei vier fünf sechs');
  assert.equal(say('+49 421 1234'), 'plus vier neun, vier zwo eins, eins zwo drei vier');
});

test('text without digits is unchanged', () => {
  const text = 'Guten Abend, was kann ich für Sie tun?';
  assert.equal(say(text), text);
});

test('spellOutNumbers only for German', () => {
  assert.equal(spellOutNumbers('de-DE'), say);
  assert.equal(spellOutNumbers('en-GB'), undefined);
});
