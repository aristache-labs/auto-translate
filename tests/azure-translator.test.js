import { test } from 'node:test';
import assert from 'node:assert/strict';
import { azureTranslate, testAzureTranslatorConnection } from '../src/js/azure-translator.js';
import { setProviderInvoke } from '../src/js/provider-client.js';

test('azureTranslate validates subscription key and text inputs', async () => {
  await assert.rejects(
    async () => azureTranslate('', 'eastus', 'en', 'vi', 'Hello'),
    /subscription key is required/i
  );

  const emptyRes = await azureTranslate('key123', 'eastus', 'en', 'vi', '');
  assert.equal(emptyRes.translatedText, '');

  const sameRes = await azureTranslate('key123', 'eastus', 'en', 'en', 'Hello');
  assert.equal(sameRes.translatedText, 'Hello');
});

test('testAzureTranslatorConnection validates missing credentials', async () => {
  const res = await testAzureTranslatorConnection('');
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('required'));
});

test('azureTranslate delegates the authenticated request to the Tauri backend', async (t) => {
  t.after(() => setProviderInvoke(null));
  let call;
  setProviderInvoke(async (command, args) => {
    call = { command, args };
    return { source_text: args.text, translated_text: 'Bună' };
  });

  const result = await azureTranslate(
    'key123',
    'eastus',
    'en',
    'ro',
    'Hello',
    'https://api.cognitive.microsofttranslator.com',
  );

  assert.equal(call.command, 'azure_translate_text');
  assert.deepEqual(call.args, {
    subscriptionKey: 'key123',
    region: 'eastus',
    endpoint: 'https://api.cognitive.microsofttranslator.com',
    sourceLanguage: 'en',
    targetLanguage: 'ro',
    text: 'Hello',
  });
  assert.equal(result.translatedText, 'Bună');
});

test('Azure connection test passes region and endpoint to the native ping', async (t) => {
  t.after(() => setProviderInvoke(null));
  let call;
  setProviderInvoke(async (command, args) => {
    call = { command, args };
    return true;
  });

  const result = await testAzureTranslatorConnection(
    'key123',
    'eastus',
    'https://api.cognitive.microsofttranslator.com',
  );

  assert.equal(result.ok, true);
  assert.equal(call.command, 'azure_translator_ping');
  assert.equal(call.args.region, 'eastus');
  assert.equal(call.args.endpoint, 'https://api.cognitive.microsofttranslator.com');
});
