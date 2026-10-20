import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CatalogDeps,
  createCatalog,
  type KugelLike,
  labelFromId,
  type MistralLike,
  normalizeGender,
} from './catalog.js';

// Made-up data only: no real voice ids, no real account content.
const KEY = 'sk-test-must-never-be-in-a-reason';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that answers from a table of URL prefixes and records what it was asked. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!route) throw new Error(`unexpected request: ${url}`);
    return routes[route]!();
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

const kugelVoices = Array.from({ length: 130 }, (_unused, index) => ({
  id: 1000 + index,
  name: `Voice ${index}`,
  description: index === 0 ? 'A calm test voice' : undefined,
  sex: index % 2 ? 'female' : 'male',
  supportedLanguages: ['de', 'en'],
  sampleUrl: index === 0 ? 'https://example.invalid/sample.mp3' : undefined,
}));

function fakeKugel(): { client: KugelLike; pages: number[] } {
  const pages: number[] = [];
  return {
    pages,
    client: {
      models: { list: async () => [{ id: 'kugel-test', name: 'Kugel Test' }] },
      voices: {
        list: async ({ limit = 100, offset = 0 }) => {
          pages.push(offset);
          return { voices: kugelVoices.slice(offset, offset + limit), total: kugelVoices.length };
        },
      },
    },
  };
}

const mistralCards = [
  { id: 'chat-a', name: 'Chat A', capabilities: { completionChat: true, functionCalling: true } },
  { id: 'chat-notools', capabilities: { completionChat: true, functionCalling: false } },
  { id: 'chat-internal', internal: true, capabilities: { completionChat: true, functionCalling: true } },
  { id: 'speech-a', capabilities: { audioSpeech: true } },
  { id: 'embed-a', capabilities: {} },
];

function fakeMistral(): MistralLike {
  return {
    models: { list: async () => ({ data: mistralCards }) },
    audio: {
      voices: {
        list: async ({ offset }) => ({
          items:
            offset === 0
              ? [{ id: 'voice-uuid-1', name: 'Test Preset', languages: ['de'], gender: null, description: 'made up' }]
              : [],
          total: 1,
        }),
      },
    },
  };
}

function catalog(deps: CatalogDeps = {}) {
  return createCatalog({ env: { MISTRAL_API_KEY: KEY, KUGELAUDIO_API_KEY: KEY, CARTESIA_API_KEY: KEY }, ...deps });
}

test('a provider without a key is unavailable, with a reason and without a request', async () => {
  const { fetch: fetchFn, calls } = fakeFetch({});
  const service = createCatalog({ env: {}, fetch: fetchFn });
  for (const target of ['mistral', 'cartesia', 'kugel', 'llm'] as const) {
    const result = await service.get(target);
    assert.equal(result.available, false, target);
    assert.ok(result.reason, target);
    assert.deepEqual([result.models, result.voices], [[], []]);
  }
  assert.equal(calls.length, 0);
});

test('kugel: paginates past the page limit and normalizes voices', async () => {
  const { client, pages } = fakeKugel();
  const result = await catalog({ kugel: () => client }).get('kugel', { language: 'de-DE' });
  assert.equal(result.available, true);
  assert.deepEqual(pages, [0, 100]);
  assert.equal(result.voices.length, 130);
  assert.deepEqual(result.models, [{ id: 'kugel-test', label: 'Kugel Test' }]);
  assert.deepEqual(result.voices[0], {
    id: '1000',
    name: 'Voice 0',
    languages: ['de', 'en'],
    gender: 'male',
    description: 'A calm test voice',
    sampleUrl: 'https://example.invalid/sample.mp3',
  });
  assert.equal('description' in result.voices[1]!, false);
});

test('kugel: the key reaches the client with the EU prefix a call uses', async () => {
  const keys: string[] = [];
  const { client } = fakeKugel();
  await catalog({
    kugel: (apiKey) => {
      keys.push(apiKey);
      return client;
    },
  }).get('kugel');
  assert.deepEqual(keys, [`eu-${KEY}`]);
});

test('mistral: speech models and voices; llm: chat models that can call tools', async () => {
  const service = catalog({ mistral: () => fakeMistral() });
  const speech = await service.get('mistral');
  assert.deepEqual(speech.models, [
    {
      id: 'speech-a',
      label: 'Speech A',
      capabilities: { tools: false, vision: false, reasoning: false, audioIn: false, audioOut: true },
    },
  ]);
  assert.deepEqual(speech.voices, [
    { id: 'voice-uuid-1', name: 'Test Preset', languages: ['de'], description: 'made up' },
  ]);

  const llm = await service.get('llm');
  assert.deepEqual(
    llm.models.map((model) => [model.id, model.label]),
    [['chat-a', 'Chat A']],
  );
  assert.deepEqual(llm.voices, []);
});

test('openrouter: needs no key; voices belong to their model', async () => {
  const { fetch: fetchFn, calls } = fakeFetch({
    'https://openrouter.ai/api/v1/models': () =>
      jsonResponse({
        data: [
          {
            id: 'acme/speak-1',
            name: 'Acme: Speak',
            description: 'Made up.',
            created: 1_700_000_000,
            context_length: 0,
            pricing: { prompt: '0.000015', completion: '0' },
            top_provider: { max_completion_tokens: 0 },
            supported_voices: ['ann', 'bob'],
          },
          { id: 'acme/speak-2', name: 'Acme: Speak 2', pricing: { prompt: 'free' } },
        ],
      }),
  });
  const result = await createCatalog({ env: {}, fetch: fetchFn }).get('openrouter');
  assert.match(calls[0]!.url, /output_modalities=speech/);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ['acme/speak-1', 'acme/speak-2'],
  );
  // Zeros and unparsable prices are not facts.
  assert.deepEqual(result.models[0], {
    id: 'acme/speak-1',
    label: 'Acme: Speak',
    description: 'Made up.',
    pricing: { prompt: 0.000015, completion: 0 },
    created: '2023-11-14T22:13:20.000Z',
  });
  assert.deepEqual(result.models[1], { id: 'acme/speak-2', label: 'Acme: Speak 2' });
  assert.deepEqual(
    result.voices.map((entry) => [entry.id, entry.model]),
    [
      ['ann', 'acme/speak-1'],
      ['bob', 'acme/speak-1'],
    ],
  );
});

test('cartesia: sends key and version, follows the cursor, reads accent locales', async () => {
  let page = 0;
  const { fetch: fetchFn, calls } = fakeFetch({
    'https://api.cartesia.ai/voices': () =>
      jsonResponse(
        page++ === 0
          ? {
              data: [
                {
                  id: 'cv-1',
                  name: 'Test One',
                  tagline: 'Warm',
                  gender: 'feminine',
                  language: 'de',
                  accents: [{ accent: 'standard-german', locale: 'de-DE', is_native: true }],
                },
              ],
              has_more: true,
              next_page: 'cv-1',
            }
          : { data: [{ id: 'cv-2', name: 'Test Two', language: 'de' }], has_more: false, next_page: null },
      ),
  });
  const result = await catalog({ fetch: fetchFn }).get('cartesia', { language: 'de-DE' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers['X-API-Key'], KEY);
  assert.equal(calls[0]!.headers['Cartesia-Version'], '2025-04-16');
  assert.match(calls[0]!.url, /language=de(&|$)/);
  assert.match(calls[1]!.url, /starting_after=cv-1/);
  assert.deepEqual(result.voices, [
    { id: 'cv-1', name: 'Test One', languages: ['de-DE'], description: 'Warm', gender: 'female' },
    { id: 'cv-2', name: 'Test Two', languages: ['de'] },
  ]);
  assert.equal(result.models.length, 1);
});

test('pocket: asks its own server, falls back to the image defaults on a 404', async () => {
  const env = { POCKET_TTS_URL: 'http://pocket.invalid:1/' };
  const listed = fakeFetch({
    'http://pocket.invalid:1/voices': () => jsonResponse({ voices: ['one', 'two'], language: 'german' }),
  });
  const result = await createCatalog({ env, fetch: listed.fetch }).get('pocket');
  assert.deepEqual(
    result.voices.map((entry) => entry.id),
    ['one', 'two'],
  );
  assert.deepEqual(result.voices[0]!.languages, ['german']);

  const old = fakeFetch({ 'http://pocket.invalid:1/voices': () => jsonResponse({ error: 'not found' }, 404) });
  const fallback = await createCatalog({ env, fetch: old.fetch }).get('pocket');
  assert.equal(fallback.available, true);
  assert.ok(fallback.voices.length > 0);
});

test('network errors and error statuses are unavailable, never thrown, never carry the key', async () => {
  const down = createCatalog({
    env: { CARTESIA_API_KEY: KEY, POCKET_TTS_URL: 'http://pocket.invalid:1' },
    fetch: (async () => {
      throw new Error(`connect failed for ${KEY}`);
    }) as typeof fetch,
  });
  for (const target of ['cartesia', 'openrouter', 'pocket'] as const) {
    const result = await down.get(target);
    assert.equal(result.available, false, target);
    assert.ok(result.reason, target);
    assert.equal(JSON.stringify(result).includes(KEY), false, target);
  }

  const denied = fakeFetch({ 'https://api.cartesia.ai/': () => jsonResponse({ error: KEY }, 401) });
  const result = await catalog({ fetch: denied.fetch }).get('cartesia');
  assert.equal(result.available, false);
  assert.match(result.reason ?? '', /401/);

  const broken = catalog({
    kugel: () => {
      throw new Error(`bad key ${KEY}`);
    },
  });
  assert.equal(JSON.stringify(await broken.get('kugel')).includes(KEY), false);
});

test('cache: one hour, refresh bypasses it, failures are not cached', async () => {
  let time = 1_000_000;
  let asked = 0;
  const { client } = fakeKugel();
  const service = catalog({
    now: () => time,
    kugel: () => {
      asked++;
      return client;
    },
  });
  await service.get('kugel');
  await service.get('kugel');
  assert.equal(asked, 1);
  await service.get('kugel', { refresh: true });
  assert.equal(asked, 2);
  time += 61 * 60 * 1000;
  await service.get('kugel');
  assert.equal(asked, 3);
  // Another language is another list.
  await service.get('kugel', { language: 'en' });
  assert.equal(asked, 4);

  let failing = true;
  const flaky = createCatalog({
    env: {},
    fetch: (async () => (failing ? jsonResponse({}, 500) : jsonResponse({ data: [] }))) as typeof fetch,
  });
  assert.equal((await flaky.get('openrouter')).available, false);
  failing = false;
  assert.equal((await flaky.get('openrouter')).available, true);
});

test('labelFromId: versions, sizes, dates and brand words', () => {
  assert.equal(labelFromId('mistral-small-2603'), 'Mistral Small (2026-03)');
  assert.equal(labelFromId('mistral-small-latest'), 'Mistral Small');
  assert.equal(labelFromId('glm-5-2'), 'GLM 5.2');
  assert.equal(labelFromId('ministral-14b-latest'), 'Ministral 14B');
  assert.equal(labelFromId('voxtral-mini-tts-2603'), 'Voxtral Mini TTS (2026-03)');
  assert.equal(labelFromId('mistral-vibe-cli-fast'), 'Mistral Vibe CLI Fast');
});

test('mistral: aliases are grouped under the canonical model, each id keeps its own label', async () => {
  const caps = { completionChat: true, functionCalling: true, vision: true };
  const cards = [
    // An alias carries its target's name, and the target lists the alias back.
    {
      id: 'demo-small-latest',
      name: 'demo-small-2601',
      aliases: ['demo-small-2601'],
      maxContextLength: 1000,
      capabilities: caps,
    },
    {
      id: 'demo-small-2601',
      name: 'demo-small-2601',
      aliases: ['demo-small-latest'],
      description: 'Made up.',
      maxContextLength: 1000,
      created: 1_700_000_000,
      capabilities: caps,
    },
    {
      id: 'demo-old-2501',
      name: 'demo-old-2501',
      deprecation: new Date('2026-12-01T00:00:00Z'),
      deprecationReplacementModel: 'demo-small-2601',
      capabilities: caps,
    },
  ];
  const service = catalog({
    mistral: () => ({ ...fakeMistral(), models: { list: async () => ({ data: cards }) } }),
  });
  const { models } = await service.get('llm');
  const [alias, canonical, old] = models;
  assert.deepEqual([alias!.label, canonical!.label], ['Demo Small', 'Demo Small (2026-01)']);
  assert.equal(alias!.latest, true);
  assert.equal(alias!.aliasOf, 'demo-small-2601');
  assert.equal(canonical!.aliasOf, undefined);
  assert.deepEqual(canonical!.aliases, ['demo-small-latest']);
  assert.equal(canonical!.description, 'Made up.');
  assert.equal(canonical!.contextLength, 1000);
  assert.equal(canonical!.created, undefined);
  assert.equal(canonical!.capabilities?.tools, true);
  assert.equal(canonical!.latest, undefined);
  assert.equal(old!.deprecated, true);
  assert.equal(old!.deprecatedAt, '2026-12-01T00:00:00.000Z');
  assert.equal(old!.replacement, 'demo-small-2601');
  assert.equal(canonical!.deprecated, undefined);
});

test('mistral: two ids of one tts model get different labels', async () => {
  const cards = [
    { id: 'demo-tts-2603', name: 'Demo TTS', aliases: ['demo-tts-latest'], capabilities: { audioSpeech: true } },
    { id: 'demo-tts-latest', name: 'Demo TTS', aliases: ['demo-tts-2603'], capabilities: { audioSpeech: true } },
  ];
  const service = catalog({ mistral: () => ({ ...fakeMistral(), models: { list: async () => ({ data: cards }) } }) });
  const { models } = await service.get('mistral');
  assert.deepEqual(
    models.map((model) => model.label),
    ['Demo TTS (2026-03)', 'Demo TTS'],
  );
  // A dated id is canonical when the vendor's name is not an id.
  assert.equal(models[1]!.aliasOf, 'demo-tts-2603');
});

test('kugel: description and input limit from the vendor', async () => {
  const result = await catalog({
    kugel: () => ({
      ...fakeKugel().client,
      models: { list: async () => [{ id: 'k-1', name: 'K One', description: 'Made up.', maxInputLength: 500 }] },
    }),
  }).get('kugel');
  assert.deepEqual(result.models, [{ id: 'k-1', label: 'K One', description: 'Made up.', maxInput: 500 }]);
});

test('cartesia and pocket: static entries with a readable name', async () => {
  const cartesia = await catalog({
    fetch: fakeFetch({ 'https://api.cartesia.ai/voices': () => jsonResponse({ data: [] }) }).fetch,
  }).get('cartesia');
  assert.equal(cartesia.models[0]!.label, 'Sonic 3.6');
  assert.ok(cartesia.models[0]!.description);
  const pocket = await createCatalog({
    env: { POCKET_TTS_URL: 'http://pocket.invalid:1' },
    fetch: fakeFetch({ 'http://pocket.invalid:1/voices': () => jsonResponse({}, 404) }).fetch,
  }).get('pocket');
  assert.equal(pocket.models[0]!.label, 'Kyutai Pocket TTS');
});

test('normalizeGender: vendor words map to female, male or neutral; anything else stays unknown', () => {
  assert.equal(normalizeGender('feminine'), 'female');
  assert.equal(normalizeGender(' Female '), 'female');
  assert.equal(normalizeGender('masculine'), 'male');
  assert.equal(normalizeGender('M'), 'male');
  assert.equal(normalizeGender('gender_neutral'), 'neutral');
  for (const unknown of ['', 'child', null, undefined, 3]) assert.equal(normalizeGender(unknown), undefined);
});
