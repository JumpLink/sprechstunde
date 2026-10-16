import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { connect, type TLSSocket } from 'node:tls';
import { parseArgs } from 'node:util';
import {
  buildRegister,
  contactCount,
  digestAuthorization,
  parseChallenge,
  parseResponse,
  type RegisterRequest,
  type SipResponse,
} from '../sip/register.js';
import { _ } from '../i18n.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(_('%s must be set').replace('%s', name));
  return value;
}

function usage(): void {
  console.log(
    [
      _('usage: sip-contacts [list|clear] [--ipv4|--ipv6]'),
      _('Asks the provider registrar how many contacts it holds for SIP_PROVIDER_USER.'),
      _('  clear   remove every contact (REGISTER with Contact: * and Expires: 0)'),
      _('  --ipv4, --ipv6  address family; default follows SIP_PROVIDER_IPV6'),
      _('Prints only status lines and counts, never contact addresses.'),
    ].join('\n'),
  );
}

/** Reads one SIP response from the stream; provisional (1xx) responses are skipped. */
function reader(socket: TLSSocket): () => Promise<SipResponse> {
  let buffer = '';
  const waiting: Array<() => void> = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    waiting.splice(0).forEach((wake) => wake());
  });
  const next = async (): Promise<SipResponse> => {
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end >= 0) {
        const head = buffer.slice(0, end + 4);
        const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
        if (buffer.length >= end + 4 + length) {
          buffer = buffer.slice(end + 4 + length);
          const response = parseResponse(head);
          if (response.status >= 200) return response;
          continue;
        }
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(_('no answer from the registrar'))), 10_000);
        waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return next;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { ipv4: { type: 'boolean' }, ipv6: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const command = positionals[0] ?? 'list';
  if (values.help || !['list', 'clear'].includes(command)) {
    usage();
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const [host = '', port = '5061'] = required('SIP_PROVIDER_HOST').split(':');
  const user = required('SIP_PROVIDER_USER');
  const password = required('SIP_PROVIDER_PASSWORD');
  const domain = process.env.SIP_PROVIDER_DOMAIN || host;
  const family = values.ipv4 ? 4 : values.ipv6 || process.env.SIP_PROVIDER_IPV6 === 'yes' ? 6 : 4;

  const { address } = await lookup(host, { family });
  const socket = connect({ host: address, port: Number(port), servername: host });
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });
  const next = reader(socket);
  const base: RegisterRequest = {
    uri: `sip:${host}:${port}`,
    user,
    domain,
    local: { address: socket.localAddress ?? '', port: socket.localPort ?? 0 },
    callId: randomBytes(12).toString('hex'),
    fromTag: randomBytes(4).toString('hex'),
    cseq: 1,
    ...(command === 'clear' ? { contact: '*', expires: 0 } : {}),
  };
  try {
    socket.write(buildRegister(base));
    let response = await next();
    const header = response.headers.find(([name]) => name === 'www-authenticate')?.[1];
    if (response.status === 401 && header) {
      const authorization = digestAuthorization(parseChallenge(header), { user, password }, base.uri);
      socket.write(buildRegister({ ...base, cseq: 2, authorization }));
      response = await next();
    }
    console.log(`${response.status} ${response.reason}`);
    if (response.status !== 200) {
      process.exitCode = 1;
      return;
    }
    console.log(_('Contacts registered:'), contactCount(response));
  } finally {
    socket.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
