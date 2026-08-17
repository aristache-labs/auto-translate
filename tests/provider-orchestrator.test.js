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
  shouldFireLiveTranslation,
  LIVE_TRANSLATION_TIMEOUT_MS,
} from '../src/js/provider-orchestrator.js';

const FULL_SETTINGS = {
  assemblyai_enabled: true,
  assemblyai_api_key: 'aai_key',
  groq_enabled: true,
  groq_api_key: 'gsk_123',
  groq_llm_model: 'openai/gpt-oss-120b',
  cloudflare_enabled: true,
  cloudflare_account_id: 'acct',
  cloudflare_api_token: 'tok',
  cloudflare_llm_model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  local_stt_enabled: true,
  azure_translator_enabled: true,
  azure_translator_key: 'az',
  gemini_enabled: true,
  gemini_api_key: 'gem',
  ollama_enabled: true,
  ollama_model: 'qwen2.5:7b',
  llm_provider: 'automatic',
};

test('classifyError categorizes HTTP status codes properly', () => {
  assert.equal(classifyError(429, '{}', 'gemini'), ERROR_TYPES.QUOTA);
  assert.equal(classifyError(null, 'Quota exhausted: daily limit', 'groq'), ERROR_TYPES.QUOTA);
  assert.equal(classifyError(null, 'Rate limit exceeded', 'gemini'), ERROR_TYPES.QUOTA);
  assert.equal(classifyError(408, '{}', 'groq'), ERROR_TYPES.TEMPORARY);
  assert.equal(classifyError(500, '{}', 'groq'), ERROR_TYPES.TEMPORARY);
  assert.equal(classifyError(503, '{}', 'cloudflare'), ERROR_TYPES.TEMPORARY);
  assert.equal(classifyError(401, '{}', 'gemini'), ERROR_TYPES.CONFIG);
  assert.equal(classifyError(403, '{}', 'azure'), ERROR_TYPES.CONFIG);
  assert.equal(classifyError(404, '{}', 'azure'), ERROR_TYPES.CONFIG);
  assert.equal(classifyError(410, '{}', 'groq'), ERROR_TYPES.CONFIG);
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
  const key = breakerKey('translation', 'azure');
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
  const sanitized = sanitizeErrorMessage(msg, 'azure');
  assert.equal(sanitized.includes('sk-1234567890abcdef'), false);
  assert.equal(sanitized.includes('secretToken'), false);
  const longMsg = 'A'.repeat(500);
  assert.ok(sanitizeErrorMessage(longMsg, 'test').length <= 200);
});

test('formatErrorNotification provides clear user messages', () => {
  const quotaMsg = formatErrorNotification('gemini', ERROR_TYPES.QUOTA);
  assert.ok(quotaMsg.includes('Gemini') && quotaMsg.includes('quota'));
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

test('effective translation order is Azure → Gemini → Cloudflare → Ollama', () => {
  const expected = ['azure', 'gemini', 'cloudflare-llm', 'ollama'];
  assert.deepEqual(getEffectiveTranslationChain(FULL_SETTINGS, 'groq'), expected);
  assert.deepEqual(getEffectiveTranslationChain(FULL_SETTINGS, 'cloudflare'), expected);
  assert.deepEqual(getEffectiveTranslationChain(FULL_SETTINGS, 'assemblyai'), expected);
  assert.deepEqual(getEffectiveTranslationChain(FULL_SETTINGS, 'local-stt'), expected);
  assert.equal(expected.includes('openrouter'), false);
  assert.equal(expected.includes('groq-llm'), false);
  assert.equal(expected.includes('assemblyai'), false);
});

test('manual LLM with fallback starts at the selected provider then follows Automatic', () => {
  assert.deepEqual(getEffectiveTranslationChain({
    ...FULL_SETTINGS,
    llm_provider: 'azure',
    llm_fallback: true,
  }), ['azure', 'gemini', 'cloudflare-llm', 'ollama']);
  assert.deepEqual(getEffectiveTranslationChain({
    ...FULL_SETTINGS,
    llm_provider: 'gemini',
    llm_fallback: true,
  }), ['gemini', 'azure', 'cloudflare-llm', 'ollama']);
  assert.deepEqual(getEffectiveTranslationChain({
    ...FULL_SETTINGS,
    llm_provider: 'groq-llm',
    llm_fallback: false,
  }), ['azure', 'gemini', 'cloudflare-llm', 'ollama']);
  assert.deepEqual(getEffectiveTranslationChain({
    ...FULL_SETTINGS,
    llm_provider: 'openrouter',
  }), ['azure', 'gemini', 'cloudflare-llm', 'ollama']);
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
    if (cmd === 'azure_translate_text') throw new Error('HTTP 429');
    if (cmd === 'gemini_translate_text') throw new Error('HTTP 500');
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
  assert.ok(calls.includes('azure_translate_text'));
  assert.ok(calls.includes('gemini_translate_text'));
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

test('HTTP 404 translation errors open the config breaker', () => {
  resetAllCircuitBreakers();
  const parsed = parseProviderError({
    provider: 'azure',
    capability: 'translation',
    kind: 'temporary',
    status: 404,
    message: 'HTTP 404',
  });
  assert.equal(parsed.kind, ERROR_TYPES.CONFIG);
  applyProviderError(parsed);
  assert.equal(isCircuitBreakerOpen(breakerKey('translation', 'azure')), true);
  resetAllCircuitBreakers();
});

test('live translation throttle fires on new words or interval', () => {
  assert.equal(shouldFireLiveTranslation({
    text: 'one two three',
    lastSentText: '',
    lastSentAt: 0,
  }), true);
  assert.equal(shouldFireLiveTranslation({
    text: 'one two three four five six seven eight nine ten eleven twelve',
    lastSentText: 'one two',
    lastSentAt: Date.now() - 2100,
  }), true);
  assert.equal(shouldFireLiveTranslation({
    text: 'one two three',
    lastSentText: 'one two three',
    lastSentAt: Date.now(),
  }), false);
  // 1 word added with only 100ms elapsed (well under 300ms threshold)
  assert.equal(shouldFireLiveTranslation({
    text: 'one two three four',
    lastSentText: 'one two three',
    lastSentAt: Date.now() - 100,
    minIntervalMs: 300,
  }), false);
  // 1 word added with enough time elapsed
  assert.equal(shouldFireLiveTranslation({
    text: 'one two three four',
    lastSentText: 'one two three',
    lastSentAt: Date.now() - 1000,
  }), true);
});
test('live translation mode skips same-provider retry and respects timeout', async () => {
  resetAllCircuitBreakers();
  let calls = 0;
  const invoke = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 40));
    throw new Error('HTTP 503');
  };
  await assert.rejects(() => translateWithChain({
    settings: FULL_SETTINGS,
    activeStt: 'assemblyai',
    text: 'hello',
    sourceLanguage: 'en',
    targetLanguage: 'ro',
    segmentId: 'live_1',
    generation: 1,
    isCurrent: () => true,
    invoke,
    timeoutMs: LIVE_TRANSLATION_TIMEOUT_MS,
    allowRetry: false,
    mode: 'live',
  }));
  // One attempt per available provider — no same-provider retry in live mode.
  assert.ok(calls >= 1);
  assert.equal(calls, getEffectiveTranslationChain(FULL_SETTINGS, 'assemblyai').length);
  resetAllCircuitBreakers();
});
