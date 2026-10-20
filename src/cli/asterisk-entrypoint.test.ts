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
  for (const file of ['pjsip.conf.template', 'rtp.conf']) copyFileSync(join(DIR, file), join(dir, file));
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
