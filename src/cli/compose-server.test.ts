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
  assert.match(unit, /ExecStart=.*compose -f compose\.yaml -f compose\.server\.yaml --profile agent up -d/);
  assert.match(unit, /ExecStop=.*compose -f compose\.yaml -f compose\.server\.yaml --profile agent down/);
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
