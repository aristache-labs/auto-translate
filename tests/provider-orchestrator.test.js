import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  getRetryAfter,
  isCircuitBreakerOpen,
  openCircuitBreaker,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  sanitizeErrorMessage,
  formatErrorNotification,
  getEffectiveTranslationChain,
  getEffectiveSTTChain,
  getSttStartOrder,
  nextSttProvider,
  preferredRecoveryStt,
  canTransitionStt,
  markSttTransition,
  parseProviderError,
  applyProviderError,
  translateWithChain,
  noteHalfOpenProbe,
  noteProviderSuccess,
  isCircuitBreakerHalfOpen,
  breakerKey,
  setNowFn,
  allocateSegmentId,
  ERROR_TYPES,
} from '../src/js/provider-orchestrator.js';

const FULL_SETTINGS = {
  assemblyai_enabled: true,
  assemblyai_api_key: 'aai_key',
  groq_enabled: true,
  groq_api_key: 'gsk_123',
  groq_llm_model: 'llama-3.1-8b-instant',
  cloudflare_enabled: true,
  cloudflare_account_id: 'acct',
  cloudflare_api_token: 'tok',
  cloudflare_llm_model: '@cf/meta/llama-3.1-8b-instruct-fast',
  local_stt_enabled: true,
  openrouter_enabled: true,
  openrouter_api_key: 'sk-or-123',
  azure_translator_enabled: true,
  azure_translator_key: 'az',
  gemini_enabled: true,
  gemini_api_key: 'gem',
  ollama_enabled: true,
  ollama_model: 'qwen2.5:7b',
  llm_provider: 'automatic',
};

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

test('circuit breaker opens, half-opens, and resets all capability keys', () => {
  resetAllCircuitBreakers();
  const key = breakerKey('stt', 'groq');
  assert.equal(isCircuitBreakerOpen(key), false);
  openCircuitBreaker(key, Date.now() + 5000);
  assert.equal(isCircuitBreakerOpen(key), true);
  assert.equal(getEffectiveSTTChain(FULL_SETTINGS, { isAppleSilicon: true }).includes('groq'), false);
  resetCircuitBreaker('groq');
  assert.equal(isCircuitBreakerOpen(key), false);
  assert.equal(getEffectiveSTTChain(FULL_SETTINGS, { isAppleSilicon: true }).includes('groq'), true);
});

test('expired cooldown allows one half-open recovery probe', () => {
  resetAllCircuitBreakers();
  let t = 1_000;
  setNowFn(() => t);
  const key = breakerKey('translation', 'openrouter');
  openCircuitBreaker(key, 2_000);
  assert.equal(isCircuitBreakerOpen(key), true);
  t = 2_500;
  assert.equal(isCircuitBreakerOpen(key), false);
  assert.equal(isCircuitBreakerHalfOpen(key), true);
  noteHalfOpenProbe(key);
  assert.equal(isCircuitBreakerOpen(key), true);
  noteProviderSuccess(key);
  assert.equal(isCircuitBreakerOpen(key), false);
  setNowFn();
});

test('sanitizeErrorMessage strips keys, tokens, and auth headers', () => {
  const msg = 'Error with key="sk-1234567890abcdef" authorization=Bearer secretToken';
  const sanitized = sanitizeErrorMessage(msg, 'openrouter');
  assert.equal(sanitized.includes('sk-1234567890abcdef'), false);
  assert.equal(sanitized.includes('secretToken'), false);
  const longMsg = 'A'.repeat(500);
  assert.ok(sanitizeErrorMessage(longMsg, 'test').length <= 200);
});

test('formatErrorNotification provides clear user messages', () => {
  const quotaMsg = formatErrorNotification('openrouter', ERROR_TYPES.QUOTA);
  assert.ok(quotaMsg.includes('OpenRouter') && quotaMsg.includes('quota'));
  const retryMsg = formatErrorNotification('groq', ERROR_TYPES.TEMPORARY, true);
  assert.ok(retryMsg.includes('Retrying'));
});

test('effective STT chain is AssemblyAI → Groq → Cloudflare → Local', () => {
  const chain = getEffectiveSTTChain(FULL_SETTINGS, { isAppleSilicon: true, os: 'macos' });
  assert.deepEqual(chain, ['assemblyai', 'groq', 'cloudflare', 'local-stt']);
});

test('missing, disabled, blocked, or unsupported STT providers are filtered', () => {
  resetAllCircuitBreakers();
  assert.deepEqual(getEffectiveSTTChain({
    groq_enabled: false,
    cloudflare_account_id: '',
    local_stt_enabled: true,
  }, { os: 'windows', isAppleSilicon: false }), []);

  const blocked = getEffectiveSTTChain({
    ...FULL_SETTINGS,
    assemblyai_enabled: false,
  }, { isAppleSilicon: true });
  assert.deepEqual(blocked, ['groq', 'cloudflare', 'local-stt']);

  openCircuitBreaker(breakerKey('stt', 'groq'), Date.now() + 60_000);
  const afterBreak = getEffectiveSTTChain(FULL_SETTINGS, { isAppleSilicon: true });
  assert.equal(afterBreak.includes('groq'), false);
  resetAllCircuitBreakers();
});

test('unsupported Local STT is skipped on Windows', () => {
  const chain = getEffectiveSTTChain(FULL_SETTINGS, { os: 'windows', isAppleSilicon: false });
  assert.deepEqual(chain, ['assemblyai', 'groq', 'cloudflare']);
});

test('effective translation order changes with active STT provider', () => {
  const groq = getEffectiveTranslationChain(FULL_SETTINGS, 'groq');
  assert.deepEqual(groq, ['openrouter', 'groq-llm', 'cloudflare-llm', 'azure', 'gemini', 'ollama']);
  const cf = getEffectiveTranslationChain(FULL_SETTINGS, 'cloudflare');
  assert.deepEqual(cf, ['openrouter', 'cloudflare-llm', 'groq-llm', 'azure', 'gemini', 'ollama']);
  const aai = getEffectiveTranslationChain(FULL_SETTINGS, 'assemblyai');
  assert.deepEqual(aai, ['openrouter', 'groq-llm', 'cloudflare-llm', 'azure', 'gemini', 'ollama']);
  const local = getEffectiveTranslationChain(FULL_SETTINGS, 'local-stt');
  assert.deepEqual(local, ['openrouter', 'groq-llm', 'cloudflare-llm', 'azure', 'gemini', 'ollama']);
  assert.equal(aai.includes('assemblyai'), false);
});

test('manual Groq primary starts at Groq then continues down the chain', () => {
  const order = getSttStartOrder({
    ...FULL_SETTINGS,
    translation_mode: 'groq',
  }, { isAppleSilicon: true });
  assert.deepEqual(order, ['groq', 'cloudflare', 'local-stt']);
  assert.equal(nextSttProvider({ ...FULL_SETTINGS, translation_mode: 'groq' }, { isAppleSilicon: true }, 'groq'), 'cloudflare');
});

test('translation failures rotate through the configured order and ignore stale jobs', async () => {
  resetAllCircuitBreakers();
  const calls = [];
  const invoke = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'openrouter_translate_text') throw new Error('HTTP 429');
    if (cmd === 'groq_translate_text') throw new Error('HTTP 500');
    return { translated_text: 'ok-cf' };
  };
  const result = await translateWithChain({
    settings: FULL_SETTINGS,
    activeStt: 'groq',
    text: 'hello',
    sourceLanguage: 'en',
    targetLanguage: 'vi',
    segmentId: 'seg1',
    generation: 'seg1',
    isCurrent: () => true,
    invoke,
  });
  assert.equal(result.translatedText, 'ok-cf');
  assert.equal(result.provider, 'cloudflare-llm');
  assert.ok(calls.includes('openrouter_translate_text'));
  assert.ok(calls.includes('groq_translate_text'));
  assert.ok(calls.includes('cloudflare_translate_text'));

  const stale = await translateWithChain({
    settings: FULL_SETTINGS,
    activeStt: 'groq',
    text: 'hello',
    sourceLanguage: 'en',
    targetLanguage: 'vi',
    segmentId: 'old',
    generation: 1,
    isCurrent: () => false,
    invoke,
  });
  assert.equal(stale.ignored, true);
  resetAllCircuitBreakers();
});

test('STT recovery prefers a higher-priority provider after dwell', () => {
  resetAllCircuitBreakers();
  setNowFn(() => 50_000);
  markSttTransition(1_000);
  assert.equal(canTransitionStt(50_000), true);
  assert.equal(
    preferredRecoveryStt(FULL_SETTINGS, { isAppleSilicon: true }, 'groq'),
    'assemblyai',
  );
  setNowFn();
});

test('STT recovery occurs only at a finalized-turn boundary', () => {
  resetAllCircuitBreakers();
  let t = 1_000;
  setNowFn(() => t);
  markSttTransition(1_000);
  const maybeRecover = ({ running, fallback, provisional }) => {
    if (!running || fallback) return null;
    if (provisional) return null;
    if (!canTransitionStt()) return null;
    return preferredRecoveryStt(FULL_SETTINGS, { isAppleSilicon: true }, 'groq');
  };
  assert.equal(maybeRecover({ running: true, fallback: false, provisional: 'hello' }), null);
  assert.equal(maybeRecover({ running: true, fallback: false, provisional: '' }), null);
  t = 20_000;
  assert.equal(maybeRecover({ running: true, fallback: false, provisional: 'still talking' }), null);
  assert.equal(maybeRecover({ running: true, fallback: false, provisional: '' }), 'assemblyai');
  setNowFn();
});

test('structured quota errors open the matching capability breaker', () => {
  resetAllCircuitBreakers();
  applyProviderError({
    provider: 'groq',
    capability: 'stt',
    kind: 'quota',
    status: 429,
    retryAfterMs: 5000,
    message: 'rate limited',
  });
  assert.equal(isCircuitBreakerOpen(breakerKey('stt', 'groq')), true);
  assert.equal(isCircuitBreakerOpen(breakerKey('translation', 'groq')), false);
  resetAllCircuitBreakers();
});

test('allocateSegmentId is unique', () => {
  const ids = new Set(Array.from({ length: 20 }, () => allocateSegmentId()));
  assert.equal(ids.size, 20);
});

test('parseProviderError never keeps bearer tokens', () => {
  const parsed = parseProviderError('authorization=Bearer super-secret-token HTTP 401');
  assert.equal(parsed.message.includes('super-secret-token'), false);
});
