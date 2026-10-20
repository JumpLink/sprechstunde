/**
 * What an uploaded or fetched file really is. The type comes from the first bytes, never from the
 * file name or the content-type the sender claims: those are the sender's word.
 */

export type DocumentKind = 'pdf' | 'image';

export interface DetectedFile {
  kind: DocumentKind;
  mime: string;
}

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Math.max(MAX_PDF_BYTES, MAX_IMAGE_BYTES);

/** Content types a server may call a PDF or a picture; octet-stream is common for PDFs and is checked by its bytes. */
export const PDF_TYPES = ['application/pdf', 'application/octet-stream'];
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

export function detectFile(bytes: Uint8Array): DetectedFile | undefined {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'pdf', mime: 'application/pdf' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  // RIFF <size> WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { kind: 'image', mime: 'image/webp' };
  }
  return undefined;
}

export const limitFor = (kind: DocumentKind): number => (kind === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES);

/** A file name safe to show and to put in a header: no path, no control characters, bounded. */
export function cleanFileName(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : '';
  const printable = Array.from(raw, (char) => (char < ' ' || char === '\u007f' ? ' ' : char)).join('');
  const name = printable.split(/[\\/]/).pop()!.replace(/\s+/g, ' ').trim();
  return (name || fallback).slice(0, 120);
}
