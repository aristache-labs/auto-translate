import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  getRetryAfter,
  isCircuitBreakerOpen,
  openCircuitBreaker,
  resetCircuitBreaker,
  sanitizeErrorMessage,
  formatErrorNotification,
  getEffectiveTranslationChain,
  getEffectiveSTTChain,
  ERROR_TYPES,
} from '../src/js/provider-orchestrator.js';

test('classifyError categorizes HTTP status codes properly', () => {
  assert.equal(classifyError(429, '{}', 'openrouter'), ERROR_TYPES.QUOTA);
  assert.equal(classifyError(408, '{}', 'groq'), ERROR_TYPES.TEMPORARY);
  assert.equal(classifyError(500, '{}', 'groq'), ERROR_TYPES.TEMPORARY);
  assert.equal(classifyError(503, '{}', 'cloudflare'), ERROR_TYPES.TEMPORARY);
  assert.equal(classifyError(401, '{}', 'gemini'), ERROR_TYPES.CONFIG);
  assert.equal(classifyError(403, '{}', 'azure'), ERROR_TYPES.CONFIG);
  assert.equal(classifyError(null, '{}', 'local'), ERROR_TYPES.UNSUPPORTED);
});

test('getRetryAfter handles seconds header and fallback', () => {
  assert.equal(getRetryAfter({}, 200), null);
  const resetSec = getRetryAfter({ 'retry-after': '30' }, 429);
  assert.ok(resetSec > Date.now());
  assert.ok(resetSec < Date.now() + 35000);

  const resetDefault = getRetryAfter({}, 429);
  assert.ok(resetDefault > Date.now() + 55000);
});

test('circuit breaker opens and closes cleanly', () => {
  resetCircuitBreaker('test-provider');
  assert.equal(isCircuitBreakerOpen('test-provider'), false);

  openCircuitBreaker('test-provider', Date.now() + 5000);
  assert.equal(isCircuitBreakerOpen('test-provider'), true);

  resetCircuitBreaker('test-provider');
  assert.equal(isCircuitBreakerOpen('test-provider'), false);
});

test('sanitizeErrorMessage strips sensitive patterns', () => {
  const msg = 'Error with key="sk-1234567890abcdef"';
  const sanitized = sanitizeErrorMessage(msg, 'openrouter');
  assert.equal(sanitized.includes('sk-1234567890abcdef'), false);

  const longMsg = 'A'.repeat(500);
  assert.ok(sanitizeErrorMessage(longMsg, 'test').length <= 200);
});

test('formatErrorNotification provides clear user messages', () => {
  const quotaMsg = formatErrorNotification('openrouter', ERROR_TYPES.QUOTA);
  assert.ok(quotaMsg.includes('OpenRouter') && quotaMsg.includes('quota'));

  const retryMsg = formatErrorNotification('groq', ERROR_TYPES.TEMPORARY, true);
  assert.ok(retryMsg.includes('Retrying'));
});

test('effective chains accurately filter enabled & configured providers', () => {
  const settings = {
    openrouter_enabled: true,
    openrouter_api_key: 'key123',
    azure_translator_enabled: false,
    gemini_enabled: false,
    ollama_enabled: true,
    ollama_model: 'qwen2.5:7b',
    groq_enabled: true,
    groq_api_key: 'gsk_123',
    groq_llm_model: 'openai/gpt-oss-20b',
  };

  const transChain = getEffectiveTranslationChain(settings, 'groq');
  assert.deepEqual(transChain, ['openrouter', 'groq-llm', 'ollama']);

  const sttChain = getEffectiveSTTChain(settings);
  assert.deepEqual(sttChain, ['groq']);
});
