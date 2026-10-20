/**
 * Text from a PDF or a picture, by Mistral OCR. The document goes to Mistral (the regional endpoint
 * when `SPRECHSTUNDE_MISTRAL_SERVER` says so) as a data URL; nothing is uploaded to a file store there.
 */

import { type Mistral } from '@mistralai/mistralai';
import { _ } from '../i18n.js';
import { mistralClient } from '../mistral.js';
import { type DocumentKind } from './file-kinds.js';

/** The alias follows Mistral's current OCR model; it was listed on the global and the EU endpoint on 2026-10-20. */
export const OCR_MODEL = 'mistral-ocr-latest';
/** Pages read per PDF, and pictures per source: what one review and one bill can bear. */
export const MAX_OCR_PAGES = 30;

export interface OcrDocument {
  kind: DocumentKind;
  mime: string;
  bytes: Uint8Array;
}

/** One Markdown text per page, in order. */
export type Ocr = (document: OcrDocument) => Promise<string[]>;

/** The picture placeholders OCR leaves in the text point at files we do not have. */
const IMAGE_PLACEHOLDER = /!\[[^\]]*\]\([^)]*\)/g;

export class OcrFailed extends Error {
  constructor() {
    super(_('the text could not be read from the document'));
    this.name = 'OcrFailed';
  }
}

export function mistralOcr(
  client: () => Pick<Mistral, 'ocr'> = mistralClient,
  log: (message: string) => void = console.error,
): Ocr {
  return async (document) => {
    const data = `data:${document.mime};base64,${Buffer.from(document.bytes).toString('base64')}`;
    try {
      const response = await client().ocr.process({
        model: OCR_MODEL,
        document:
          document.kind === 'pdf' ? { type: 'document_url', documentUrl: data } : { type: 'image_url', imageUrl: data },
        // The API ignores indexes past the end, so this is a ceiling, not a promise.
        ...(document.kind === 'pdf' && { pages: Array.from({ length: MAX_OCR_PAGES }, (_unused, index) => index) }),
      });
      return response.pages
        .slice()
        .sort((a, b) => a.index - b.index)
        .slice(0, MAX_OCR_PAGES)
        .map((page) => page.markdown.replace(IMAGE_PLACEHOLDER, '').trim());
    } catch (error) {
      // The reason stays in the log: a provider's message is not for the page.
      log(`ocr failed: ${(error as Error).message}`);
      throw new OcrFailed();
    }
  };
}
