import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = 'deploy/asterisk';
const BASE = {
  SIP_PROVIDER_HOST: 'sip.example:5061',
  SIP_PROVIDER_DOMAIN: 'example.invalid',
  SIP_PROVIDER_USER: 'user',
  SIP_PROVIDER_PASSWORD: 'secret',
  SIP_PROVIDER_NUMBER: '100',
};

/** Runs the part of entrypoint.sh that renders the config, against a scratch copy of /etc/asterisk. */
function render(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'asterisk-'));
  for (const file of ['pjsip.conf.template', 'pjsip-line.conf.template', 'rtp.conf'])
    copyFileSync(join(DIR, file), join(dir, file));
  const script = readFileSync(join(DIR, 'entrypoint.sh'), 'utf8')
    .split('\n# extensions.conf reads these')[0]!
    .replaceAll('/etc/asterisk', dir);
  writeFileSync(join(dir, 'run.sh'), script);
  const run = spawnSync('sh', [join(dir, 'run.sh')], {
    env: { PATH: process.env.PATH!, ...BASE, ...env },
    encoding: 'utf8',
  });
  return {
    run,
    pjsip: () => readFileSync(join(dir, 'pjsip.conf'), 'utf8'),
    rtp: () => readFileSync(join(dir, 'rtp.conf'), 'utf8'),
  };
}

test('asterisk entrypoint: the RTP range comes from the environment, with a default', () => {
  const custom = render({ SIP_RTP_START: '20000', SIP_RTP_END: '20099' });
  assert.equal(custom.run.status, 0, custom.run.stderr);
  assert.match(custom.rtp(), /^rtpstart=20000$/m);
  assert.match(custom.rtp(), /^rtpend=20099$/m);
  const fallback = render({});
  assert.match(fallback.rtp(), /^rtpstart=12000$/m);
  assert.match(fallback.rtp(), /^rtpend=12100$/m);
});

test('asterisk entrypoint: a broken RTP range stops the container', () => {
  for (const range of <Array<Record<string, string>>>[
    { SIP_RTP_START: '9', SIP_RTP_END: '5' },
    { SIP_RTP_START: 'x' },
    { SIP_RTP_END: '70000' },
  ]) {
    const result = render(range).run;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SIP_RTP_START/);
  }
});

test('asterisk entrypoint: public addresses and local networks land on the provider transport', () => {
  const nat = render({
    SIP_PUBLIC_ADDRESS: '203.0.113.7',
    SIP_PUBLIC_SIGNALING_ADDRESS: '203.0.113.8',
    SIP_LOCAL_NET: '10.1.0.0/16,127.0.0.0/8',
  }).pjsip();
  assert.match(
    nat,
    /^\[transport-tls-provider\]\nexternal_signaling_address=203\.0\.113\.8\nexternal_media_address=203\.0\.113\.7\nlocal_net=10\.1\.0\.0\/16\nlocal_net=127\.0\.0\.0\/8\n/m,
  );
  const defaults = render({ SIP_PUBLIC_ADDRESS: '203.0.113.7' }).pjsip();
  assert.match(defaults, /local_net=192\.168\.0\.0\/16/);
  assert.doesNotMatch(defaults, /external_signaling_address/);
  assert.doesNotMatch(render({}).pjsip(), /external_media_address/);
});

/** The `[name]` sections of one type, each as its lines. */
function sections(pjsip: string, type: string): string[] {
  return pjsip.split(/^(?=\[)/m).filter((section) => new RegExp(`^type=${type}$`, 'm').test(section));
}

test('asterisk entrypoint: without SIP_LINES the one line "main" is built from SIP_PROVIDER_*', () => {
  const pjsip = render({ SIP_PROVIDER_MEDIA_ENCRYPTION: 'no' }).pjsip();
  const [registration, ...more] = sections(pjsip, 'registration');
  assert.equal(more.length, 0);
  assert.match(registration!, /^\[provider-main\]$/m);
  assert.match(registration!, /^server_uri=sip:sip\.example:5061$/m);
  assert.match(registration!, /^client_uri=sip:user@example\.invalid$/m);
  assert.match(registration!, /^contact_user=user$/m);
  assert.match(registration!, /^line=yes$/m);
  assert.match(registration!, /^fatal_retry_interval=300$/m);
  const [auth] = sections(pjsip, 'auth');
  assert.match(auth!, /^username=user$/m);
  assert.match(auth!, /^password=secret$/m);
  assert.match(auth!, /^realm=example\.invalid$/m);
  const endpoints = sections(pjsip, 'endpoint').filter((section) => section.startsWith('[provider-'));
  assert.equal(endpoints.length, 1);
  assert.match(endpoints[0]!, /^context=from-provider$/m);
  assert.match(endpoints[0]!, /^media_encryption=no$/m);
  assert.match(endpoints[0]!, /^set_var=SPRECHSTUNDE_LINE=main$/m);
  assert.match(endpoints[0]!, /^set_var=SPRECHSTUNDE_LINE_NUMBER=100$/m);
  assert.doesNotMatch(endpoints[0]!, /rtp_ipv6/);
  const [identify, ...otherIdentify] = sections(pjsip, 'identify').filter((section) =>
    section.startsWith('[provider-'),
  );
  assert.equal(otherIdentify.length, 0);
  assert.match(identify!, /^match=sip\.example:5061$/m);
  assert.equal(
    render({})
      .pjsip()
      .match(/media_encryption=sdes/g)?.length,
    1,
    'sdes stays the default',
  );
});

test('asterisk entrypoint: each line gets its own registration, overriding the provider values', () => {
  const pjsip = render({
    SIP_LINES: 'main,test-2',
    SIP_LINE_TEST_2_USER: 'other',
    SIP_LINE_TEST_2_PASSWORD: 'other-secret',
    SIP_LINE_TEST_2_NUMBER: '200',
    SIP_LINE_TEST_2_MEDIA_ENCRYPTION: 'no',
  }).pjsip();
  const registrations = sections(pjsip, 'registration');
  assert.equal(registrations.length, 2);
  assert.match(registrations[0]!, /^\[provider-main\]$/m);
  assert.match(registrations[1]!, /^\[provider-test-2\]$/m);
  assert.match(registrations[1]!, /^contact_user=other$/m);
  assert.match(registrations[1]!, /^line=yes$/m);
  assert.match(registrations[1]!, /^server_uri=sip:sip\.example:5061$/m);
  const endpoints = sections(pjsip, 'endpoint').filter((section) => section.startsWith('[provider-'));
  assert.match(endpoints[0]!, /^set_var=SPRECHSTUNDE_LINE_NUMBER=100$/m);
  assert.match(endpoints[0]!, /^media_encryption=sdes$/m);
  assert.match(endpoints[1]!, /^set_var=SPRECHSTUNDE_LINE=test-2$/m);
  assert.match(endpoints[1]!, /^set_var=SPRECHSTUNDE_LINE_NUMBER=200$/m);
  assert.match(endpoints[1]!, /^media_encryption=no$/m);
  const identifies = sections(pjsip, 'identify').filter((section) => section.startsWith('[provider-'));
  assert.equal(identifies.length, 1, 'a host match cannot tell lines apart: only the first line gets one');
  assert.match(identifies[0]!, /^endpoint=provider-main$/m);
});

test('asterisk entrypoint: a line id or a missing credential stops the container', () => {
  for (const [env, message] of [
    [{ SIP_LINES: 'main,Main' }, /not a line id/],
    [{ SIP_LINES: 'main,a_b' }, /not a line id/],
    [{ SIP_LINES: 'main,main' }, /listed twice/],
    [{ SIP_LINES: 'a'.repeat(21) }, /longer than 20/],
    [{ SIP_LINES: 'main,test', SIP_LINE_MAIN_NUMBER: '100', SIP_PROVIDER_NUMBER: '' }, /SIP_LINE_TEST_NUMBER/],
  ] as const) {
    const result = render(env).run;
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.match(result.stderr, message);
  }
});

test('asterisk entrypoint: IPv6 media applies to every line endpoint', () => {
  const pjsip = render({ SIP_PROVIDER_IPV6: 'yes', SIP_LINES: 'main,test', SIP_LINE_TEST_NUMBER: '200' }).pjsip();
  const endpoints = sections(pjsip, 'endpoint').filter((section) => section.startsWith('[provider-'));
  assert.equal(endpoints.length, 2);
  for (const endpoint of endpoints) assert.match(endpoint, /^rtp_ipv6=yes$/m);
  assert.match(pjsip, /^bind=\[::\]:0$/m);
});
