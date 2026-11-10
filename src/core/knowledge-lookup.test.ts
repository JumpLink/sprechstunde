import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DETAILS_MARKER, LOOKUP_TOOL_NAME, lookupDetails, lookupTool, splitReference } from './knowledge-lookup.js';
import { renderSnapshot, type SnapshotSection } from './knowledge-snapshot.js';
import { loadProfile, type Profile } from './profile.js';
import { buildInstructions } from './prompt.js';

const section = (title: string, markdown: string): SnapshotSection => ({
  sourceTitle: 'Feed',
  title,
  url: 'https://venue.example/feed',
  at: '2026-03-04T10:00:00.000Z',
  edited: false,
  markdown,
});

const MENU = `The menu of Harbour Kitchen: soups, grills and desserts.\n\n${'- Rump steak, 28.00\n'.repeat(120)}`;
const snapshot = renderSnapshot([
  section('About', 'A small restaurant.'),
  section('Menu', MENU),
  section('Menu', MENU),
]);

test('splitReference: short sections stay, long ones shrink to their summary', () => {
  const { text, details } = splitReference(snapshot);
  assert.match(text, /## About\nSource:/);
  assert.match(text, /A small restaurant\./);
  assert.match(text, new RegExp(`## Menu ${DETAILS_MARKER.replace(/[()]/g, '\\$&')}\\n`));
  assert.match(text, /The menu of Harbour Kitchen: soups, grills and desserts\./);
  assert.ok(!text.includes('Rump steak'));
  assert.ok(text.length < snapshot.length / 3);
  assert.deepEqual([...details.keys()], ['Menu', 'Menu (2)']);
  assert.ok(details.get('Menu')?.includes('Rump steak, 28.00'));
});

test('splitReference: a snapshot of short sections is returned as it was', () => {
  const small = renderSnapshot([section('About', 'A small restaurant.')]);
  const { text, details } = splitReference(small);
  assert.equal(text, small);
  assert.equal(details.size, 0);
});

test('splitReference: a long summary is cut at a word', () => {
  const long = renderSnapshot([section('Menu', `${'word '.repeat(200)}\n\n${'x'.repeat(2000)}`)]);
  const summary = /<reference-data>\n(.*)\n<\/reference-data>/.exec(splitReference(long).text)?.[1] ?? '';
  assert.ok(summary.length <= 402);
  assert.ok(summary.endsWith('word…'));
});

test('lookupDetails: finds a section by name, fenced as data; unknown names list the choices', () => {
  const { details } = splitReference(snapshot);
  const found = lookupDetails(details, ' menu (2) ');
  assert.ok(found.startsWith('<reference-data>\n') && found.endsWith('\n</reference-data>'));
  assert.ok(found.includes('Rump steak'));
  assert.match(lookupDetails(details, 'Drinks'), /No such section\. Sections: Menu, Menu \(2\)\./);
  assert.match(lookupDetails(details, undefined), /No such section/);
});

test('lookupTool: the section names are the only values', () => {
  const tool = lookupTool(['Menu']);
  assert.equal(tool.name, LOOKUP_TOOL_NAME);
  assert.deepEqual((tool.parameters.properties.section as { enum: string[] }).enum, ['Menu']);
  assert.deepEqual(tool.parameters.required, ['section']);
});

test('buildInstructions: the lookup rule appears only when a section shows a summary', () => {
  const profile: Profile = loadProfile('profiles/example/profile.de.json');
  const now = new Date('2026-03-04T10:00:00Z');
  const withLookup = buildInstructions(profile, now, undefined, splitReference(snapshot).text);
  assert.ok(withLookup.includes(LOOKUP_TOOL_NAME));
  assert.ok(!withLookup.includes('Only if no listed fact fits'));
  const without = buildInstructions(profile, now, undefined, renderSnapshot([section('About', 'A small restaurant.')]));
  assert.ok(!without.includes(LOOKUP_TOOL_NAME));
  assert.ok(without.includes('Only if no listed fact fits'));
});
