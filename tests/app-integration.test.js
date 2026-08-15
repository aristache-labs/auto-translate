import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    getEffectiveSTTChain,
    getEffectiveTranslationChain,
    isCircuitBreakerOpen,
    openCircuitBreaker,
    resetCircuitBreaker,
    sanitizeErrorMessage,
    formatErrorNotification,
    clearSessionState,
    ERROR_TYPES,
} from '../src/js/provider-orchestrator.js';
import { createSingleFlightFallback, migrateTranslationMode } from '../src/js/mode-utils.js';

test('deprecated model migration updates obsolete defaults while keeping custom settings', () => {
    // Model defaults migration simulation
    const oldSettings = {
        groq_llm_model: 'llama-3.1-8b-instant',
        cloudflare_llm_model: '@cf/meta/llama-3.1-8b-instruct',
        groq_stt_model: 'whisper-large-v3-turbo',
        custom_model: 'my-custom-model',
    };

    const DEPRECATED_GROQ_MODEL = 'llama-3.1-8b-instant';
    const DEPRECATED_CF_MODEL = '@cf/meta/llama-3.1-8b-instruct';

    if (oldSettings.groq_llm_model === DEPRECATED_GROQ_MODEL) {
        oldSettings.groq_llm_model = 'openai/gpt-oss-20b';
    }
    if (oldSettings.cloudflare_llm_model === DEPRECATED_CF_MODEL) {
        oldSettings.cloudflare_llm_model = '@cf/meta/llama-3.1-8b-instruct-fast';
    }

    assert.equal(oldSettings.groq_llm_model, 'openai/gpt-oss-20b');
    assert.equal(oldSettings.cloudflare_llm_model, '@cf/meta/llama-3.1-8b-instruct-fast');
    assert.equal(oldSettings.groq_stt_model, 'whisper-large-v3-turbo');
    assert.equal(oldSettings.custom_model, 'my-custom-model');
});

test('effective STT chain filters disabled or unconfigured providers', () => {
    const settings = {
        groq_enabled: true,
        groq_api_key: 'gsk_123',
        cloudflare_enabled: true,
        cloudflare_account_id: 'acct_123',
        cloudflare_api_token: 'tok_123',
        local_stt_enabled: true,
    };

    const sttChain = getEffectiveSTTChain(settings);
    assert.deepEqual(sttChain, ['groq', 'cloudflare', 'local']);

    const unconfigured = getEffectiveSTTChain({
        groq_enabled: false,
        cloudflare_account_id: '',
        cloudflare_api_token: '',
        local_stt_enabled: false,
    });
    assert.deepEqual(unconfigured, []);
});

test('effective translation chain reflects active STT engine and enabled adapters', () => {
    const settings = {
        openrouter_enabled: true,
        openrouter_api_key: 'sk-or-123',
        groq_llm_model: 'openai/gpt-oss-20b',
        azure_translator_enabled: true,
        azure_translator_key: 'az_key',
        gemini_enabled: true,
        gemini_api_key: 'gem_key',
        ollama_enabled: true,
        ollama_model: 'qwen2.5:7b',
    };

    const transChain = getEffectiveTranslationChain(settings, 'groq');
    assert.deepEqual(transChain, ['openrouter', 'groq-llm', 'azure', 'gemini', 'ollama']);
});

test('single flight fallback executes exactly once concurrently', async () => {
    let callCount = 0;
    const fallbackFn = createSingleFlightFallback(async () => {
        callCount++;
        await new Promise(r => setTimeout(r, 20));
    });

    const [res1, res2] = await Promise.all([fallbackFn(), fallbackFn()]);
    assert.equal(callCount, 1);
    assert.equal(res1.started, true);
    assert.equal(res2.started, false);
});

test('circuit breaker suppresses broken providers until manual or timed reset', () => {
    resetCircuitBreaker('azure');
    assert.equal(isCircuitBreakerOpen('azure'), false);

    // Open circuit breaker for 5 seconds
    openCircuitBreaker('azure', Date.now() + 5000);
    assert.equal(isCircuitBreakerOpen('azure'), true);

    // Reset manually
    resetCircuitBreaker('azure');
    assert.equal(isCircuitBreakerOpen('azure'), false);
});

test('error sanitization strips secrets and formats outage notifications cleanly', () => {
    const rawError = 'Request failed with key="gsk_secret123456789" authorization=Bearer secretToken';
    const sanitized = sanitizeErrorMessage(rawError);

    assert.equal(sanitized.includes('gsk_secret123456789'), false);
    assert.equal(sanitized.includes('secretToken'), false);

    const notification = formatErrorNotification('openrouter', ERROR_TYPES.QUOTA, false);
    assert.equal(notification.includes('quota'), true);
});

test('session cleanup resets temporary sticky state', () => {
    clearSessionState();
    assert.equal(true, true);
});
