import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downsampleS16le, encodeWav, f32leToS16le, wavHeader } from './audio.js';

function f32(...samples: number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(samples.length * 4));
  samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  return new Uint8Array(view.buffer);
}

function s16(...samples: number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return new Uint8Array(view.buffer);
}

function readS16(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Array.from({ length: data.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
}

test('f32 to s16 scales, rounds and clips', () => {
  assert.deepEqual(readS16(f32leToS16le(f32(0, 1, -1, 0.5, 2, -2))), [0, 32767, -32767, 16384, 32767, -32768]);
});

test('f32 to s16 ignores a trailing partial sample', () => {
  const data = new Uint8Array([...f32(1), 0xff, 0xff]);
  assert.equal(f32leToS16le(data).byteLength, 2);
});

test('wav header describes mono 16-bit PCM', () => {
  const header = new DataView(wavHeader(24000, 1000).buffer);
  const text = (offset: number) => String.fromCharCode(...new Uint8Array(header.buffer, offset, 4));
  assert.equal(text(0), 'RIFF');
  assert.equal(header.getUint32(4, true), 1036);
  assert.equal(text(8), 'WAVE');
  assert.equal(text(12), 'fmt ');
  assert.equal(header.getUint16(20, true), 1);
  assert.equal(header.getUint16(22, true), 1);
  assert.equal(header.getUint32(24, true), 24000);
  assert.equal(header.getUint32(28, true), 48000);
  assert.equal(header.getUint16(34, true), 16);
  assert.equal(text(36), 'data');
  assert.equal(header.getUint32(40, true), 1000);
});

test('encodeWav puts the samples right after the header', () => {
  const wav = encodeWav(8000, s16(1, -2));
  assert.equal(wav.byteLength, 48);
  assert.deepEqual(readS16(wav.subarray(44)), [1, -2]);
});

test('downsample averages groups and drops the incomplete tail', () => {
  assert.deepEqual(readS16(downsampleS16le(s16(0, 30, 100, 200, 7), 2)), [15, 150]);
  assert.equal(downsampleS16le(s16(1, 2, 3, 4, 5, 6, 7), 3).byteLength, 4);
});

test('downsample by 1 is the identity and bad factors are rejected', () => {
  assert.deepEqual(readS16(downsampleS16le(s16(5, -5), 1)), [5, -5]);
  assert.throws(() => downsampleS16le(s16(1), 0), /factor/);
  assert.throws(() => downsampleS16le(s16(1), 1.5), /factor/);
});
