import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRegister,
  contactCount,
  digestAuthorization,
  hostPort,
  parseChallenge,
  parseResponse,
} from './register.js';

const request = {
  uri: 'sip:registrar.example:5061',
  user: 'alice',
  domain: 'example.org',
  local: { address: '2001:db8::1', port: 40000 },
  callId: 'call-1',
  fromTag: 'tag1',
  cseq: 1,
};

test('hostPort: brackets IPv6 only', () => {
  assert.equal(hostPort('192.0.2.1', 5061), '192.0.2.1:5061');
  assert.equal(hostPort('2001:db8::1', 5061), '[2001:db8::1]:5061');
});

test('buildRegister: clear-all request', () => {
  const message = buildRegister({ ...request, contact: '*', expires: 0 });
  const lines = message.split('\r\n');
  assert.equal(lines[0], 'REGISTER sip:registrar.example:5061 SIP/2.0');
  assert.match(lines[1]!, /^Via: SIP\/2\.0\/TLS \[2001:db8::1\]:40000;rport;branch=z9hG4bK[0-9a-f]{16};alias$/);
  assert.ok(lines.includes('Contact: *'));
  assert.ok(lines.includes('Expires: 0'));
  assert.ok(lines.some((line) => line.startsWith('User-Agent: ')));
  assert.ok(message.endsWith('Content-Length: 0\r\n\r\n'));
});

test('buildRegister: listing request has no Contact or Expires', () => {
  const message = buildRegister(request);
  assert.doesNotMatch(message, /^(Contact|Expires):/m);
});

test('parseResponse and contactCount', () => {
  const response = parseResponse(
    [
      'SIP/2.0 200 OK',
      'Via: SIP/2.0/TLS x',
      'Contact: <sip:a@192.0.2.1:5061>;expires=600, <sip:a@192.0.2.2:5061>;expires=300',
      'contact: <sip:a@[2001:db8::2]:5061>;expires=60',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n'),
  );
  assert.equal(response.status, 200);
  assert.equal(response.reason, 'OK');
  assert.equal(contactCount(response), 3);
  assert.equal(contactCount(parseResponse('SIP/2.0 200 OK\r\n\r\n')), 0);
  assert.throws(() => parseResponse('HTTP/1.1 200 OK\r\n\r\n'));
});

test('parseChallenge: quoted and bare values', () => {
  const challenge = parseChallenge('Digest realm="example.org", nonce="abc", qop="auth", algorithm=MD5');
  assert.deepEqual(challenge, {
    realm: 'example.org',
    nonce: 'abc',
    opaque: undefined,
    qop: 'auth',
    algorithm: 'MD5',
  });
  assert.throws(() => parseChallenge('Digest realm="x"'));
});

test('digestAuthorization: RFC 2617 section 3.5 example', () => {
  const header = digestAuthorization(
    {
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      opaque: '5ccc069c403ebaf9f0171e9517f40e41',
      qop: 'auth,auth-int',
    },
    { user: 'Mufasa', password: 'Circle Of Life' },
    '/dir/index.html',
    '0a4f113b',
    'GET',
  );
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('digestAuthorization: rejects other algorithms', () => {
  assert.throws(() =>
    digestAuthorization({ realm: 'r', nonce: 'n', algorithm: 'SHA-256' }, { user: 'u', password: 'p' }, 'sip:x'),
  );
});
