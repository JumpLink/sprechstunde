import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  createSafeFetcher,
  FetchRefused,
  nodeTransport,
  type Resolver,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './fetch-safe.js';
import { isPublicAddress } from './net-guard.js';
import { parseRobots } from './robots.js';

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

function page(body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}): TransportResponse {
  return { status: 200, headers: { 'content-type': type, ...extra }, body: chunks(body) };
}

const redirect = (to: string): TransportResponse => ({ status: 302, headers: { location: to }, body: chunks('') });
const missing = (): TransportResponse => ({ status: 404, headers: {}, body: chunks('') });

/** Hosts → addresses; anything else does not resolve. */
const dns =
  (table: Record<string, string[]>): Resolver =>
  async (host) => {
    const found = table[host];
    if (!found) throw new Error('ENOTFOUND');
    return found;
  };

interface Rig {
  seen: TransportRequest[];
  fetcher: ReturnType<typeof createSafeFetcher>;
  waits: number[];
}

function rig(
  routes: Record<string, TransportResponse | (() => TransportResponse)>,
  table: Record<string, string[]> = { 'venue.example': ['93.184.216.34'], 'other.example': ['93.184.216.35'] },
  extra: { maxBytes?: number } = {},
): Rig {
  const seen: TransportRequest[] = [];
  const waits: number[] = [];
  let clock = 1_000_000;
  const transport: Transport = async (request) => {
    seen.push(request);
    const route = routes[request.url.href];
    if (!route) return missing();
    return typeof route === 'function' ? route() : route;
  };
  const fetcher = createSafeFetcher({
    resolve: dns(table),
    transport,
    userAgent: 'sprechstunde/9.9 (+https://example.test)',
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    ...extra,
  });
  return { seen, fetcher, waits };
}

const refused = (code: string) => (error: unknown) => error instanceof FetchRefused && error.code === code;

test('isPublicAddress: public addresses pass, private ranges do not', () => {
  for (const ok of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '1.1.1.1']) {
    assert.equal(isPublicAddress(ok), true, ok);
  }
  for (const bad of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.100.100.200',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd00:ec2::254',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    'not an address',
    '',
  ]) {
    assert.equal(isPublicAddress(bad), false, bad);
  }
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
  assert.equal(isPublicAddress('172.32.0.1'), true);
});

test('parseRobots: our group wins over *, the longest rule wins, Allow wins a tie', () => {
  const rules = parseRobots(
    [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: sprechstunde',
      'Disallow: /private/',
      'Allow: /private/menu',
      'Disallow: /*.pdf$',
    ].join('\n'),
    'sprechstunde',
  );
  assert.equal(rules.allowed('/'), true);
  assert.equal(rules.allowed('/private/x'), false);
  assert.equal(rules.allowed('/private/menu'), true);
  assert.equal(rules.allowed('/a/b.pdf'), false);
  assert.equal(rules.allowed('/a/b.pdf.html'), true);
  const star = parseRobots('User-agent: *\nDisallow: /admin', 'sprechstunde');
  assert.equal(star.allowed('/admin/x'), false);
  assert.equal(star.allowed('/speisekarte'), true);
  assert.equal(parseRobots('User-agent: *\nDisallow:', 'sprechstunde').allowed('/x'), true);
});

test('fetch: a public page is returned with the final address and our user agent', async () => {
  const { fetcher, seen } = rig({
    'https://venue.example/robots.txt': page('User-agent: *\nAllow: /', 'text/plain'),
    'https://venue.example/menu': page('<p>Hallo</p>'),
  });
  const result = await fetcher.fetch('https://venue.example/menu');
  assert.equal(result.text, '<p>Hallo</p>');
  assert.equal(result.url, 'https://venue.example/menu');
  const request = seen.at(-1)!;
  assert.equal(request.headers['user-agent'], 'sprechstunde/9.9 (+https://example.test)');
  assert.equal(request.address, '93.184.216.34');
});

test('fetch: refuses what is not http(s), has credentials or an odd port', async () => {
  const { fetcher, seen } = rig({});
  await assert.rejects(fetcher.fetch('file:///etc/passwd'), refused('scheme'));
  await assert.rejects(fetcher.fetch('ftp://venue.example/'), refused('scheme'));
  await assert.rejects(fetcher.fetch('https://user:pw@venue.example/'), refused('credentials'));
  await assert.rejects(fetcher.fetch('http://venue.example:8080/'), refused('port'));
  await assert.rejects(fetcher.fetch('not a url'), refused('url'));
  assert.equal(seen.length, 0);
});

test('fetch: refuses private literals, odd spellings of loopback and names that resolve to private addresses', async () => {
  const { fetcher, seen } = rig(
    {},
    {
      'internal.example': ['10.0.0.5'],
      'mixed.example': ['93.184.216.34', '127.0.0.1'],
      'mapped.example': ['::ffff:169.254.169.254'],
      'venue.example': ['93.184.216.34'],
    },
  );
  for (const url of [
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:7f00:1]/',
    'http://internal.example/',
    'http://mixed.example/',
    'http://mapped.example/',
  ]) {
    await assert.rejects(fetcher.fetch(url), refused('private'), url);
  }
  await assert.rejects(fetcher.fetch('http://unknown.example/'), refused('dns'));
  assert.equal(seen.length, 0);
});

test('fetch: a redirect to a private address is refused at the hop', async () => {
  const { fetcher, seen } = rig({
    'https://venue.example/robots.txt': missing(),
    'https://venue.example/a': redirect('http://169.254.169.254/latest/'),
  });
  await assert.rejects(fetcher.fetch('https://venue.example/a'), refused('private'));
  assert.ok(seen.every((request) => request.url.hostname !== '169.254.169.254'));
});

test('fetch: relative redirects work, a fourth redirect is refused', async () => {
  const ok = rig({
    'https://venue.example/robots.txt': missing(),
    'https://venue.example/a': redirect('/b'),
    'https://venue.example/b': redirect('https://other.example/c'),
    'https://other.example/robots.txt': missing(),
    'https://other.example/c': page('ende'),
  });
  assert.equal((await ok.fetcher.fetch('https://venue.example/a')).url, 'https://other.example/c');

  const loop = rig({
    'https://venue.example/robots.txt': missing(),
    'https://venue.example/a': redirect('/b'),
    'https://venue.example/b': redirect('/c'),
    'https://venue.example/c': redirect('/d'),
    'https://venue.example/d': redirect('/e'),
    'https://venue.example/e': page('zu spät'),
  });
  await assert.rejects(loop.fetcher.fetch('https://venue.example/a'), refused('redirects'));
});

test('fetch: robots.txt is honoured, cached, and a server error closes the door', async () => {
  const hits: string[] = [];
  const closed = rig({
    'https://venue.example/robots.txt': () => {
      hits.push('robots');
      return page('User-agent: *\nDisallow: /geheim', 'text/plain');
    },
    'https://venue.example/geheim': page('x'),
    'https://venue.example/offen': page('y'),
  });
  await assert.rejects(closed.fetcher.fetch('https://venue.example/geheim'), refused('robots'));
  assert.equal((await closed.fetcher.fetch('https://venue.example/offen')).text, 'y');
  assert.equal(hits.length, 1);
  assert.ok(!closed.seen.some((request) => request.url.pathname === '/geheim'));

  const broken = rig({
    'https://venue.example/robots.txt': { status: 503, headers: {}, body: chunks('') },
    'https://venue.example/offen': page('y'),
  });
  await assert.rejects(broken.fetcher.fetch('https://venue.example/offen'), refused('robots'));
});

test('fetch: a host is not hit twice within the interval', async () => {
  const { fetcher, waits } = rig({
    'https://venue.example/robots.txt': missing(),
    'https://venue.example/a': page('a'),
    'https://venue.example/b': page('b'),
  });
  await fetcher.fetch('https://venue.example/a');
  await fetcher.fetch('https://venue.example/b');
  assert.ok(waits.length >= 1);
  assert.ok(waits.every((ms) => ms > 0 && ms <= 1000));
});

test('fetch: content types outside the allow-list are refused', async () => {
  const { fetcher } = rig({
    'https://venue.example/robots.txt': missing(),
    'https://venue.example/x.zip': page('PK', 'application/zip'),
    'https://venue.example/none': { status: 200, headers: {}, body: chunks('x') },
    'https://venue.example/sitemap.xml': page('<urlset/>', 'application/xml'),
  });
  await assert.rejects(fetcher.fetch('https://venue.example/x.zip'), refused('type'));
  await assert.rejects(fetcher.fetch('https://venue.example/none'), refused('type'));
  await assert.rejects(fetcher.fetch('https://venue.example/sitemap.xml'), refused('type'));
  const sitemap = await fetcher.fetch('https://venue.example/sitemap.xml', { types: ['application/xml'] });
  assert.equal(sitemap.text, '<urlset/>');
});

test('fetch: the size cap counts streamed bytes, and a declared length is checked first', async () => {
  const { fetcher } = rig(
    {
      'https://venue.example/robots.txt': missing(),
      'https://venue.example/big': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: chunks('x'.repeat(30), 'y'.repeat(30)),
      },
      'https://venue.example/declared': page('small', 'text/html', { 'content-length': '999999' }),
      'https://venue.example/fits': page('x'.repeat(40)),
    },
    undefined,
    { maxBytes: 50 },
  );
  await assert.rejects(fetcher.fetch('https://venue.example/big'), refused('size'));
  await assert.rejects(fetcher.fetch('https://venue.example/declared'), refused('size'));
  assert.equal((await fetcher.fetch('https://venue.example/fits')).text.length, 40);
});

test('fetch: error statuses, network failures and timeouts become refusals', async () => {
  const { fetcher } = rig({
    'https://venue.example/robots.txt': missing(),
    'https://venue.example/gone': { status: 404, headers: {}, body: chunks('') },
    'https://venue.example/boom': () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(fetcher.fetch('https://venue.example/gone'), refused('status'));
  await assert.rejects(fetcher.fetch('https://venue.example/boom'), refused('network'));

  const slow = createSafeFetcher({
    resolve: dns({ 'venue.example': ['93.184.216.34'] }),
    timeoutMs: 20,
    sleep: async () => {},
    transport: ({ url, signal }) =>
      url.pathname === '/robots.txt'
        ? Promise.resolve(missing())
        : new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await assert.rejects(slow.fetch('https://venue.example/slow'), refused('timeout'));
});

test('fetch: decodes the declared charset', async () => {
  const { fetcher } = rig({
    'https://venue.example/robots.txt': missing(),
    'https://venue.example/latin': {
      status: 200,
      headers: { 'content-type': 'text/html; charset=iso-8859-1' },
      body: (async function* () {
        yield Buffer.from([0x4b, 0xe4, 0x73, 0x65]);
      })(),
    },
  });
  assert.equal((await fetcher.fetch('https://venue.example/latin')).text, 'Käse');
});

test('nodeTransport: connects to the checked address whatever the name says, and unpacks gzip', async () => {
  let host = '';
  const server = createServer((request, response) => {
    host = request.headers.host ?? '';
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.end(gzipSync('<p>drin</p>'));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await nodeTransport({
      url: new URL(`http://venue.example:${port}/x`),
      address: '127.0.0.1',
      headers: { host: `venue.example:${port}` },
      signal: AbortSignal.timeout(5000),
    });
    const parts: Buffer[] = [];
    for await (const chunk of response.body) parts.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(parts).toString(), '<p>drin</p>');
    assert.equal(response.status, 200);
    assert.equal(host, `venue.example:${port}`);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
