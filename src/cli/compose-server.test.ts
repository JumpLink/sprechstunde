import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (file: string): string => readFileSync(file, 'utf8');

test('server compose: no published ports, host networking stays, transcripts are off', () => {
  const base = read('compose.yaml');
  const overlay = read('compose.server.yaml');
  assert.doesNotMatch(base, /^\s+ports:/m, 'the base publishes nothing: everything binds on the host stack');
  assert.doesNotMatch(overlay, /^\s+ports:/m);
  assert.match(overlay, /SPRECHSTUNDE_TRANSCRIPT_DIR: ""/);
  assert.match(overlay, /SIP_RTP_START/);
});

test('server compose: the boot unit starts the same two files the runbook names', () => {
  const unit = read('deploy/systemd/sprechstunde.service');
  assert.match(
    unit,
    /ExecStart=.*compose -f compose\.yaml -f compose\.server\.yaml --profile agent --profile pocket up -d/,
  );
  assert.match(
    unit,
    /ExecStop=.*compose -f compose\.yaml -f compose\.server\.yaml --profile agent --profile pocket down/,
  );
});

test('compose: health-check arguments carry no spaces', () => {
  // docker-compose talking to Podman's socket splits each CMD argument at spaces, so `node -e`
  // and `python -c` got fragments and both services stayed unhealthy on the server.
  const tests = read('compose.yaml').match(/^\s+test: \[.*\]$/gm) ?? [];
  assert.ok(tests.length >= 2);
  for (const line of tests) {
    for (const arg of JSON.parse(line.replace(/^\s+test: /, '')) as string[]) {
      assert.doesNotMatch(arg, /\s/, `health-check argument with a space: ${arg}`);
    }
  }
});

test('env.example names every variable the compose files read for the provider leg', () => {
  const example = read('.env.example');
  for (const name of [
    'SIP_PUBLIC_ADDRESS',
    'SIP_PUBLIC_SIGNALING_ADDRESS',
    'SIP_LOCAL_NET',
    'SIP_RTP_START',
    'SIP_RTP_END',
  ]) {
    assert.match(example, new RegExp(`^${name}=`, 'm'));
    assert.match(read('compose.yaml'), new RegExp(name));
  }
});

test('server compose: agent and admin leave keep-id, which an unprivileged LXC cannot map', () => {
  const base = read('compose.yaml');
  const overlay = read('compose.server.yaml');
  assert.match(base, /userns_mode: keep-id/);
  for (const service of ['agent', 'admin']) {
    assert.match(overlay, new RegExp(`^  ${service}:\\n    userns_mode: host$`, 'm'));
  }
  assert.doesNotMatch(overlay, /userns_mode: keep-id/);
});

test('server compose: the boot unit needs the Podman socket its compose provider uses', () => {
  const unit = read('deploy/systemd/sprechstunde.service');
  assert.match(unit, /^Requires=podman\.socket$/m);
  assert.match(unit, /^After=.*podman\.socket/m);
});

test('livekit: no ICE/TCP listener, so nothing but loopback and the UDP range', () => {
  const config = read('deploy/livekit.yaml');
  assert.match(config, /^  tcp_port: 0$/m);
  assert.match(config, /^bind_addresses:\n  - 127\.0\.0\.1$/m);
  assert.doesNotMatch(read('compose.yaml'), /7881/);
});

test('valkey: AOF on, no RDB, data in a mounted dir that the uid owning var/ can write', () => {
  const base = read('compose.yaml');
  const redis = base.slice(base.indexOf('\n  redis:'), base.indexOf('\n  livekit:'));
  assert.match(redis, /"--appendonly", "yes"/);
  assert.match(redis, /"--save", ""/);
  assert.match(redis, /"--dir", "\/data"/);
  assert.match(redis, /- \.\/var\/valkey:\/data:z/);
  assert.match(redis, /user: "1000:1000"/);
  assert.match(read('compose.server.yaml'), /^  redis:\n    userns_mode: host$/m);
  assert.match(read('.werkstatt-state.json'), /"path": "var\/valkey",\s+"class": "derived"/);
  assert.match(read('package.json'), /mkdir -p [^&]*var\/valkey/);
  assert.match(read('deploy/systemd/sprechstunde.service'), /mkdir -p [^\n]*var\/valkey/);
});
