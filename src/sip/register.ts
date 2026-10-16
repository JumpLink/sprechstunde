import { createHash, randomBytes } from 'node:crypto';

export interface RegisterRequest {
  /** Request-URI, e.g. `sip:tls-sip.1und1.de:5061`. */
  uri: string;
  user: string;
  domain: string;
  /** Local address and port for the Via header; IPv6 without brackets. */
  local: { address: string; port: number };
  callId: string;
  fromTag: string;
  cseq: number;
  /** `*` with expires 0 removes every binding; omitted, the registrar lists them. */
  contact?: string;
  expires?: number;
  authorization?: string;
}

export interface SipResponse {
  status: number;
  reason: string;
  headers: Array<[string, string]>;
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  qop?: string;
  algorithm?: string;
}

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

export function hostPort(address: string, port: number): string {
  return `${address.includes(':') ? `[${address}]` : address}:${port}`;
}

export function buildRegister(request: RegisterRequest): string {
  const branch = `z9hG4bK${randomBytes(8).toString('hex')}`;
  const lines = [
    `REGISTER ${request.uri} SIP/2.0`,
    // Without brackets around an IPv6 sent-by, 1&1 drops the request without any answer.
    `Via: SIP/2.0/TLS ${hostPort(request.local.address, request.local.port)};rport;branch=${branch};alias`,
    'Max-Forwards: 70',
    `From: <sip:${request.user}@${request.domain}>;tag=${request.fromTag}`,
    `To: <sip:${request.user}@${request.domain}>`,
    `Call-ID: ${request.callId}`,
    `CSeq: ${request.cseq} REGISTER`,
  ];
  if (request.contact) lines.push(`Contact: ${request.contact}`);
  if (request.expires !== undefined) lines.push(`Expires: ${request.expires}`);
  if (request.authorization) lines.push(`Authorization: ${request.authorization}`);
  // 1&1 also drops requests without a User-Agent.
  lines.push('User-Agent: sprechstunde', 'Content-Length: 0', '', '');
  return lines.join('\r\n');
}

export function parseResponse(raw: string): SipResponse {
  const [statusLine = '', ...rest] = raw.split('\r\n');
  const match = /^SIP\/2\.0 (\d{3}) ?(.*)$/.exec(statusLine);
  if (!match) throw new Error(`not a SIP response: ${statusLine.slice(0, 40)}`);
  const headers: Array<[string, string]> = [];
  for (const line of rest) {
    if (line === '') break;
    const colon = line.indexOf(':');
    if (colon > 0) headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return { status: Number(match[1]), reason: match[2] ?? '', headers };
}

export function parseChallenge(header: string): DigestChallenge {
  const params: Record<string, string> = {};
  for (const [, key, quoted, bare] of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    params[key!.toLowerCase()] = quoted ?? bare ?? '';
  }
  if (!params.realm || !params.nonce) throw new Error('digest challenge without realm or nonce');
  return {
    realm: params.realm,
    nonce: params.nonce,
    opaque: params.opaque,
    qop: params.qop,
    algorithm: params.algorithm,
  };
}

/** RFC 2617 digest; only MD5, with or without qop=auth. */
export function digestAuthorization(
  challenge: DigestChallenge,
  credentials: { user: string; password: string },
  uri: string,
  cnonce = randomBytes(8).toString('hex'),
  method = 'REGISTER',
): string {
  if (challenge.algorithm && challenge.algorithm.toUpperCase() !== 'MD5') {
    throw new Error(`unsupported digest algorithm ${challenge.algorithm}`);
  }
  const ha1 = md5(`${credentials.user}:${challenge.realm}:${credentials.password}`);
  const ha2 = md5(`${method}:${uri}`);
  const parts = [
    `username="${credentials.user}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    'algorithm=MD5',
  ];
  const auth = challenge.qop
    ?.split(',')
    .map((q) => q.trim())
    .includes('auth');
  if (auth) {
    const nc = '00000001';
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
    parts.push(`response="${md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`);
  } else {
    parts.push(`response="${md5(`${ha1}:${challenge.nonce}:${ha2}`)}"`);
  }
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

/** Bindings a registrar reports in a 200 to REGISTER, one entry per contact. */
export function contactCount(response: SipResponse): number {
  return response.headers
    .filter(([name]) => name === 'contact' || name === 'm')
    .flatMap(([, value]) => value.split(/,(?=\s*<)/))
    .filter((value) => value.trim() !== '').length;
}
