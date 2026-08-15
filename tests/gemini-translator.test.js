import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiTranslate, testGeminiConnection, getSupportedModels } from '../src/js/gemini-translator.js';
import { setProviderInvoke } from '../src/js/provider-client.js';

test('geminiTranslate validates input requirements', async () => {
  await assert.rejects(
    async () => geminiTranslate('', 'en', 'vi', 'Hello'),
    /API key is required/i
  );

  const emptyRes = await geminiTranslate('key123', 'en', 'vi', '');
  assert.equal(emptyRes.translatedText, '');

  const sameRes = await geminiTranslate('key123', 'en', 'en', 'Hello');
  assert.equal(sameRes.translatedText, 'Hello');
});

test('testGeminiConnection validates missing API key', async () => {
  const res = await testGeminiConnection('');
  assert.equal(res.ok, false);
});

test('Gemini connection test pings via native lookup, not generateContent', async (t) => {
  t.after(() => setProviderInvoke(null));
  let call;
  setProviderInvoke(async (command, args) => {
    call = { command, args };
    return true;
  });
  const res = await testGeminiConnection('key123', 'gemini-3.1-flash-lite');
  assert.equal(res.ok, true);
  assert.equal(call.command, 'gemini_ping');
  assert.equal(call.args.apiKey, 'key123');
  assert.equal(call.args.model, 'gemini-3.1-flash-lite');
});

test('getSupportedModels returns valid model array', () => {
  const models = getSupportedModels();
  assert.ok(models.length > 0);
  assert.ok(models[0].id);
});
