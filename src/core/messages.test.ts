import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMessage, deliverMessage, MESSAGE_TOOL, messageRule, type PhoneMessage } from './messages.js';

const NOW = new Date('2026-11-20T10:00:00Z');
const context = { venue: 'harbour-kitchen', callerNumber: '+4900000001', now: NOW };

test('checkMessage: the caller number is used when no callback number was given', () => {
  const checked = checkMessage({ name: ' Jo Doe ', message: 'Table for six on Friday?' }, context);
  assert.ok(checked.ok);
  assert.deepEqual(checked.message, {
    source: 'sprechstunde',
    venue: 'harbour-kitchen',
    name: 'Jo Doe',
    phone: '+4900000001',
    message: 'Table for six on Friday?',
    receivedAt: NOW.toISOString(),
  });
});

test('checkMessage: a dictated callback number is cleaned and wins over the caller number', () => {
  const checked = checkMessage({ name: 'Jo', message: 'x', callbackNumber: '0 47 21 / 12-34' }, context);
  assert.ok(checked.ok);
  assert.equal(checked.message.phone, '047211234');
});

test('checkMessage: missing name, message or number tells the LLM what to ask', () => {
  const noName = checkMessage({ message: 'x' }, context);
  assert.ok(!noName.ok && /name is missing/.test(noName.reply));
  const noText = checkMessage({ name: 'Jo', message: '  ' }, context);
  assert.ok(!noText.ok && /message is missing/.test(noText.reply));
  const hidden = checkMessage({ name: 'Jo', message: 'x' }, { ...context, callerNumber: undefined });
  assert.ok(!hidden.ok && /hidden number/.test(hidden.reply));
  const bad = checkMessage({ name: 'Jo', message: 'x', callbackNumber: 'twelve' }, context);
  assert.ok(!bad.ok && /digit by digit/.test(bad.reply));
});

test('checkMessage: long text is cut', () => {
  const checked = checkMessage({ name: 'Jo', message: 'a'.repeat(5000) }, context);
  assert.ok(checked.ok);
  assert.equal(checked.message.message.length, 2000);
});

const message: PhoneMessage = {
  source: 'sprechstunde',
  venue: 'harbour-kitchen',
  name: 'Jo Doe',
  phone: '+4900000001',
  message: 'x',
  receivedAt: NOW.toISOString(),
};

test('deliverMessage: POSTs JSON with the bearer token and reports success', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response('{}', { status: 201 });
  }) as unknown as typeof fetch;
  assert.equal(await deliverMessage('https://venue.example/api/message', 'secret', message, fetchFn), true);
  assert.equal(seen?.url, 'https://venue.example/api/message');
  assert.equal(seen?.init.method, 'POST');
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(String(seen?.init.body)), message);
});

test('deliverMessage: an error status or a network failure is a failure', async () => {
  const refused = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
  assert.equal(await deliverMessage('https://venue.example/m', undefined, message, refused), false);
  const broken = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  assert.equal(await deliverMessage('https://venue.example/m', undefined, message, broken), false);
});

test('messageRule: names when to offer a message and the tool', () => {
  assert.match(messageRule(true), /nobody answers a transfer/);
  assert.match(messageRule(false), /when you cannot help/);
  for (const rule of [messageRule(true), messageRule(false)]) assert.ok(rule.includes(MESSAGE_TOOL.name));
});
