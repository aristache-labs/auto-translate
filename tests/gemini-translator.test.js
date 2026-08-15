import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiTranslate, testGeminiConnection, getSupportedModels } from '../src/js/gemini-translator.js';

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

test('getSupportedModels returns valid model array', () => {
  const models = getSupportedModels();
  assert.ok(models.length > 0);
  assert.ok(models[0].id);
});
