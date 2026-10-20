import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSelectors, htmlToMarkdown } from './html-markdown.js';
import { matchesGlobs, parseSitemap, sameHost } from './sitemap.js';

const PAGE = `<!doctype html><html><head><title>Beispiel Küche</title><style>p{color:red}</style></head>
<body>
<header><h1>Kopf</h1></header>
<nav><a href="/x">Menü</a></nav>
<script>alert(1)</script>
<main>
  <h1>Speisekarte</h1>
  <p>Wir kochen <strong>frisch</strong>.</p>
  <ul><li>Suppe</li><li>Salat</li></ul>
  <table><thead><tr><th>Gericht</th><th>Preis</th></tr></thead><tbody><tr><td>Suppe</td><td>5</td></tr></tbody></table>
  <p><a href="/kontakt">Kontakt</a> <a href="javascript:void(0)">Klick</a> <a href="mailto:a@b.test">Mail</a></p>
  <img src="/a.png" alt="Bild">
  <div class="cookie">Cookies akzeptieren</div>
</main>
<footer>Impressum</footer>
</body></html>`;

test('htmlToMarkdown: chrome is stripped, main is chosen, tables and links survive', () => {
  const { title, markdown } = htmlToMarkdown(PAGE, { baseUrl: 'https://venue.example/de/', exclude: ['.cookie'] });
  assert.equal(title, 'Beispiel Küche');
  assert.match(markdown, /^# Speisekarte/);
  assert.match(markdown, /Wir kochen \*\*frisch\*\*\./);
  assert.match(markdown, /- Suppe/);
  assert.match(markdown, /\| Gericht \| Preis \|/);
  assert.match(markdown, /\[Kontakt\]\(https:\/\/venue\.example\/kontakt\)/);
  for (const gone of ['alert', 'Kopf', 'Menü', 'Impressum', 'Cookies', 'javascript', 'mailto', 'a.png', 'color:red']) {
    assert.ok(!markdown.includes(gone), gone);
  }
  assert.match(markdown, /Klick/);
});

test('htmlToMarkdown: article beats main, body is the fallback, junk does not throw', () => {
  assert.match(htmlToMarkdown('<body><main>M</main><article>A</article></body>').markdown, /^A$/);
  assert.equal(htmlToMarkdown('<body><p>nur Text</p></body>').markdown, 'nur Text');
  assert.equal(htmlToMarkdown('').markdown, '');
  assert.equal(htmlToMarkdown('<p>unclosed <b>tags').markdown, 'unclosed **tags**');
});

test('checkSelectors: invalid or too many selectors are refused with a message', () => {
  assert.deepEqual(checkSelectors(['.a', ' ', '#b > p']), ['.a', '#b > p']);
  assert.throws(() => checkSelectors(['div[']), /not a valid CSS selector/);
  assert.throws(() => checkSelectors(Array.from({ length: 21 }, (_unused, i) => `.c${i}`)), /too many/);
  assert.throws(() => htmlToMarkdown('<p>x</p>', { exclude: ['p['] }), /not a valid/);
});

test('parseSitemap: pages and nested sitemaps', () => {
  const pages = parseSitemap(
    '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc> https://venue.example/a </loc></url><url><loc>https://venue.example/b</loc></url></urlset>',
  );
  assert.deepEqual(pages, { pages: ['https://venue.example/a', 'https://venue.example/b'], sitemaps: [] });
  const index = parseSitemap(
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://venue.example/s1.xml</loc></sitemap></sitemapindex>',
  );
  assert.deepEqual(index, { pages: [], sitemaps: ['https://venue.example/s1.xml'] });
  assert.deepEqual(parseSitemap('not xml at all'), { pages: [], sitemaps: [] });
});

test('matchesGlobs: * stays in a segment, ** crosses, / globs match the path', () => {
  const u = 'https://venue.example/speisekarte/mittag/suppe?x=1';
  assert.equal(matchesGlobs(u, []), true);
  assert.equal(matchesGlobs(u, ['/speisekarte/**']), true);
  assert.equal(matchesGlobs(u, ['/speisekarte/*']), false);
  assert.equal(matchesGlobs('https://venue.example/speisekarte/mittag', ['/speisekarte/*']), true);
  assert.equal(matchesGlobs(u, ['/kontakt', '/speisekarte/**']), true);
  assert.equal(matchesGlobs('https://venue.example/kontakt', ['https://venue.example/*']), true);
  assert.equal(matchesGlobs('https://venue.example/a.b', ['/a.b']), true);
  assert.equal(matchesGlobs('https://venue.example/axb', ['/a.b']), false);
  assert.equal(matchesGlobs('nonsense', ['/x']), false);
});

test('sameHost', () => {
  assert.equal(sameHost('https://venue.example/a', 'https://venue.example/sitemap.xml'), true);
  assert.equal(sameHost('https://evil.example/a', 'https://venue.example/sitemap.xml'), false);
});
