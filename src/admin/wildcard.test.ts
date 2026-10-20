import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRobots } from './robots.js';
import { matchesGlobs } from './sitemap.js';
import { MAX_TEXT_CHARS, matchTokens, tokenize } from './wildcard.js';

test('matchTokens: wildcards, prefix and whole-text matching', () => {
  assert.equal(matchTokens(tokenize('/a*c', false), '/abbbc/d', true), true);
  assert.equal(matchTokens(tokenize('/a*c', false), '/abbbd', true), false);
  assert.equal(matchTokens(tokenize('/a*c', false), '/abc', false), true);
  assert.equal(matchTokens(tokenize('/a*c', false), '/abcd', false), false);
  assert.equal(matchTokens(tokenize('/x/*', true), '/x/a/b', false), false);
  assert.equal(matchTokens(tokenize('/x/**', true), '/x/a/b', false), true);
});

test('a pattern built to make a regex backtrack answers at once', () => {
  const pattern = `${'*a'.repeat(60)}b`;
  const started = Date.now();
  assert.equal(matchTokens(tokenize(pattern, false), 'a'.repeat(5000), true), false);
  assert.equal(matchTokens(tokenize(pattern, true), 'a'.repeat(5000), false), false);
  assert.ok(Date.now() - started < 1000);
});

test('robots rules and globs keep their meaning without regular expressions', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private*/x$\nAllow: /private1/x*', 'bot');
  assert.equal(rules.allowed('/private2/x'), false);
  assert.equal(rules.allowed('/private2/x/y'), true);
  assert.equal(rules.allowed('/private1/x'), true);
  assert.equal(matchesGlobs('https://a.example/menu/day/1', ['/menu/*']), false);
  assert.equal(matchesGlobs('https://a.example/menu/day/1', ['/menu/**']), true);
  assert.equal(matchesGlobs('https://a.example/menu', ['https://a.example/*']), true);
});

test('over-long input is cut, not matched at full length', () => {
  const long = '/' + 'a'.repeat(MAX_TEXT_CHARS * 2);
  assert.equal(matchTokens(tokenize('/a*b', false), long, true), false);
});
