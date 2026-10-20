import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanFileName, detectFile } from './file-kinds.js';
import { createFileStore, sha256Of } from './file-store.js';

const PDF = Buffer.from('%PDF-1.4\n%fake\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake')]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

test('detectFile: the first bytes decide, not a name or a claimed type', () => {
  assert.deepEqual(detectFile(PDF), { kind: 'pdf', mime: 'application/pdf' });
  assert.deepEqual(detectFile(PNG), { kind: 'image', mime: 'image/png' });
  assert.deepEqual(detectFile(JPEG), { kind: 'image', mime: 'image/jpeg' });
  assert.deepEqual(detectFile(WEBP), { kind: 'image', mime: 'image/webp' });
  assert.equal(detectFile(Buffer.from('<html><body>not a pdf</body></html>')), undefined);
  assert.equal(detectFile(Buffer.from('MZ\x90\x00')), undefined);
  assert.equal(detectFile(Buffer.alloc(0)), undefined);
  // a RIFF container that is not a picture (a WAV, say)
  assert.equal(detectFile(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])), undefined);
  // GIF and SVG are not accepted
  assert.equal(detectFile(Buffer.from('GIF89a')), undefined);
  assert.equal(detectFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
});

test('cleanFileName: no path, no control characters, bounded', () => {
  assert.equal(cleanFileName('../../etc/menu.pdf', 'file'), 'menu.pdf');
  assert.equal(cleanFileName('C:\\Users\\x\\menu.pdf', 'file'), 'menu.pdf');
  assert.equal(cleanFileName('a\r\nb\u0000c.png', 'file'), 'a b c.png');
  assert.equal(cleanFileName('', 'file'), 'file');
  assert.equal(cleanFileName(undefined, 'file'), 'file');
  assert.equal(cleanFileName('x'.repeat(500), 'file').length, 120);
});

test('file store: content-addressed, per tenant, and nothing outside its root', () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-files-'));
  try {
    const store = createFileStore(root);
    const sha = store.put('tenant-a', PDF);
    assert.equal(sha, sha256Of(PDF));
    assert.equal(store.put('tenant-a', PDF), sha, 'the same bytes are one file');
    assert.deepEqual(readdirSync(join(root, 'tenant-a')), [sha], 'no temp file is left behind');
    assert.deepEqual(store.get('tenant-a', sha), PDF);
    assert.equal(store.get('tenant-b', sha), undefined, 'another tenant does not see it');
    store.remove('tenant-a', sha);
    assert.equal(store.get('tenant-a', sha), undefined);
    store.remove('tenant-a', sha);
    assert.throws(() => store.get('tenant-a', '../../etc/passwd'), /invalid file reference/);
    assert.throws(() => store.put('../x', PDF), /invalid file reference/);
    assert.throws(() => store.get('a/b', sha), /invalid file reference/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
