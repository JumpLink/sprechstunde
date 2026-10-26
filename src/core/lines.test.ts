import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineIds, lineSetting, maskedLineNumber } from './lines.js';

test('lineIds: SIP_LINES unset is the one line "main"', () => {
  assert.deepEqual(lineIds({}), ['main']);
  assert.deepEqual(lineIds({ SIP_LINES: '' }), ['main']);
  assert.deepEqual(lineIds({ SIP_LINES: 'main, test,test,Bad_1' }), ['main', 'test']);
});

test('lineSetting: the line value, else the provider value', () => {
  const env = { SIP_PROVIDER_NUMBER: '+4900000001', SIP_LINE_TEST_2_NUMBER: '+4900000002' };
  assert.equal(lineSetting('test-2', 'NUMBER', env), '+4900000002');
  assert.equal(lineSetting('main', 'NUMBER', env), '+4900000001');
  assert.equal(lineSetting('main', 'HOST', env), undefined);
});

test('maskedLineNumber shows only the last two digits', () => {
  assert.equal(maskedLineNumber('main', { SIP_PROVIDER_NUMBER: '+4900000042' }), 'tel:+••••••••42');
  assert.equal(maskedLineNumber('main', {}), undefined);
});
