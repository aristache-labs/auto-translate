import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaTranslate, checkOllamaHealth, testOllamaConnection, isLoopbackUrl } from '../src/js/ollama-translator.js';

test('isLoopbackUrl strictly checks localhost and loopback IPs', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:11434'), true);
  assert.equal(isLoopbackUrl('http://localhost:11434'), true);
  assert.equal(isLoopbackUrl('http://[::1]:11434'), true);
  assert.equal(isLoopbackUrl('http://example.com:11434'), false);
  assert.equal(isLoopbackUrl('http://192.168.1.5:11434'), false);
});

test('checkOllamaHealth rejects non-loopback URLs', async () => {
  const res = await checkOllamaHealth('http://example.com:11434');
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('loopback'));
});

test('ollamaTranslate requires model name and loopback host', async () => {
  await assert.rejects(
    async () => ollamaTranslate('http://example.com:11434', 'llama3', 'en', 'vi', 'Hello'),
    /loopback/i
  );

  await assert.rejects(
    async () => ollamaTranslate('http://127.0.0.1:11434', '', 'en', 'vi', 'Hello'),
    /model name is required/i
  );
});

test('testOllamaConnection validates non-loopback host', async () => {
  const res = await testOllamaConnection('http://example.com:11434', 'llama3');
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('loopback'));
});
