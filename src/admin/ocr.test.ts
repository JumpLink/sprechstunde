import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_OCR_PAGES, mistralOcr, OCR_MODEL, OcrFailed } from './ocr.js';

type Request = { model: string; document: Record<string, string>; pages?: number[] };

function fake(pages: Array<{ index: number; markdown: string }> | Error) {
  const requests: Request[] = [];
  const client = {
    ocr: {
      async process(request: Request) {
        requests.push(request);
        if (pages instanceof Error) throw pages;
        return { pages };
      },
    },
  };
  return {
    requests,
    ocr: mistralOcr(
      () => client as never,
      () => undefined,
    ),
  };
}

test('ocr: a PDF goes out as a data URL with the page ceiling, and the pages come back in order', async () => {
  const { ocr, requests } = fake([
    { index: 1, markdown: '  Second ![img-0.jpeg](img-0.jpeg) page  ' },
    { index: 0, markdown: 'First page' },
  ]);
  const pages = await ocr({ kind: 'pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4') });
  assert.deepEqual(pages, ['First page', 'Second  page']);
  const request = requests[0]!;
  assert.equal(request.model, OCR_MODEL);
  assert.equal(request.document.type, 'document_url');
  assert.equal(
    request.document.documentUrl,
    `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`,
  );
  assert.equal(request.pages?.length, MAX_OCR_PAGES);
  assert.equal(request.pages?.[0], 0);
  assert.equal(request.pages?.at(-1), MAX_OCR_PAGES - 1);
});

test('ocr: a picture goes out as an image, without a page list', async () => {
  const { ocr, requests } = fake([{ index: 0, markdown: 'Soup' }]);
  await ocr({ kind: 'image', mime: 'image/png', bytes: Buffer.from([1, 2, 3]) });
  assert.equal(requests[0]!.document.type, 'image_url');
  assert.match(requests[0]!.document.imageUrl!, /^data:image\/png;base64,/);
  assert.equal(requests[0]!.pages, undefined);
});

test('ocr: a provider that returns more pages than asked for is cut at the ceiling', async () => {
  const many = Array.from({ length: MAX_OCR_PAGES + 5 }, (_unused, index) => ({ index, markdown: `p${index}` }));
  const { ocr } = fake(many);
  const pages = await ocr({ kind: 'pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-') });
  assert.equal(pages.length, MAX_OCR_PAGES);
});

test('ocr: a failure is a generic one; the provider text goes to the log only', async () => {
  const logged: string[] = [];
  const client = {
    ocr: {
      async process() {
        throw new Error('401 secret-detail');
      },
    },
  };
  const ocr = mistralOcr(
    () => client as never,
    (message) => logged.push(message),
  );
  await assert.rejects(
    ocr({ kind: 'image', mime: 'image/png', bytes: Buffer.from([1]) }),
    (error: unknown) => error instanceof OcrFailed && !error.message.includes('secret-detail'),
  );
  assert.match(logged[0]!, /secret-detail/);
});

test('ocr: a missing API key is found when a document is read, not when the server starts', async () => {
  const ocr = mistralOcr(
    () => {
      throw new Error('MISSING_KEY must be set');
    },
    () => undefined,
  );
  await assert.rejects(ocr({ kind: 'pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-') }), OcrFailed);
});
