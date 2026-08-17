import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    migrateTranslationMode,
    engineClassFromMode,
    nextModeForEngineClass,
    missingRequiredIds,
    redactSettings,
    createSingleFlightFallback,
    applyStartFailure,
    applyStartSuccess,
    clientConfigFromSettings,
    showFatalInitError,
    REQUIRED_INIT_IDS,
} from '../src/js/mode-utils.js';

test('legacy modes migrate to groq without inventing credentials', () => {
    for (const mode of ['soniox', 'openai', 'qwen', 'standard', 'unknown']) {
        assert.equal(migrateTranslationMode(mode), 'groq');
    }
    assert.equal(migrateTranslationMode('cloudflare'), 'cloudflare');
    assert.equal(migrateTranslationMode('local'), 'local');
    assert.equal(migrateTranslationMode('groq'), 'groq');
    assert.equal(migrateTranslationMode('automatic'), 'automatic');
    assert.equal(migrateTranslationMode('assemblyai'), 'assemblyai');
});

test('engine class maps 1:1 with groq|cloudflare|local', () => {
    assert.equal(engineClassFromMode('groq'), 'groq');
    assert.equal(engineClassFromMode('cloudflare'), 'cloudflare');
    assert.equal(engineClassFromMode('local'), 'local');
    assert.equal(engineClassFromMode('soniox'), 'groq');
    assert.equal(nextModeForEngineClass('cloudflare', 'groq'), 'cloudflare');
    assert.equal(nextModeForEngineClass('standard', 'local'), 'local');
    assert.equal(nextModeForEngineClass('standard', 'soniox'), 'groq');
});

test('required IDs are reported when missing', () => {
    const doc = { getElementById: () => null };
    const missing = missingRequiredIds(doc);
    assert.ok(missing.includes('btn-start'));
    assert.ok(missing.includes('input-groq-key'));
    assert.deepEqual(missingRequiredIds({
        getElementById: (id) => REQUIRED_INIT_IDS.includes(id) ? {} : null,
    }), []);
});

test('secret fields are redacted in logs', () => {
    const redacted = redactSettings({
        groq_api_key: 'gsk_secret',
        cloudflare_api_token: 'tok',
        cloudflare_account_id: 'acct',
        assemblyai_api_key: 'aai_secret',
        streaming_token: 'tmp_token_secret',
        translation_mode: 'groq',
        target_language: 'vi',
    });
    assert.equal(redacted.groq_api_key, '[redacted]');
    assert.equal(redacted.cloudflare_api_token, '[redacted]');
    assert.equal(redacted.cloudflare_account_id, '[redacted]');
    assert.equal(redacted.assemblyai_api_key, '[redacted]');
    assert.equal(redacted.streaming_token, '[redacted]');
    assert.equal(redacted.translation_mode, 'groq');
    assert.equal(JSON.stringify(redacted).includes('gsk_secret'), false);
    assert.equal(JSON.stringify(redacted).includes('tmp_token_secret'), false);
});

test('start failure restores stopped flags', () => {
    const failed = applyStartFailure({ isRunning: true, isStarting: true });
    assert.equal(failed.isRunning, false);
    assert.equal(failed.isStarting, false);
    const ok = applyStartSuccess({ isRunning: false, isStarting: true });
    assert.equal(ok.isRunning, true);
});

test('client config uses sourceLanguage/targetLanguage', () => {
    const cfg = clientConfigFromSettings({
        source_language: 'ja',
        target_language: 'en',
        groq_api_key: 'k',
        cloudflare_account_id: 'a',
        cloudflare_api_token: 't',
    });
    assert.equal(cfg.sourceLanguage, 'ja');
    assert.equal(cfg.targetLanguage, 'en');
    assert.equal(cfg.apiKey, 'k');
    assert.equal(cfg.sttModel, 'whisper-large-v3-turbo');
    const cf = clientConfigFromSettings({
        cloudflare_stt_model: '@cf/openai/whisper',
    }, 'cloudflare');
    assert.equal(cf.sttModel, '@cf/openai/whisper');
    const auto = clientConfigFromSettings({
        llm_provider: 'automatic',
    }, 'groq');
    assert.equal(auto.llmProvider, 'automatic');
});

test('single-flight fallback starts Cloudflare once', async () => {
    let starts = 0;
    const transition = createSingleFlightFallback(async () => {
        starts += 1;
        await new Promise((r) => setTimeout(r, 20));
    });
    const [a, b] = await Promise.all([transition(), transition()]);
    assert.equal(a.started || b.started, true);
    assert.equal(a.started && b.started, false);
    assert.equal(starts, 1);
    const c = await transition();
    assert.equal(c.started, true);
    assert.equal(starts, 2);
});

test('fatal init banner is visible', () => {
    const nodes = [];
    const banner = { id: '', textContent: '', setAttribute() {} };
    const doc = {
        body: { prepend(el) { nodes.push(el); } },
        getElementById: () => null,
        createElement: () => banner,
    };
    showFatalInitError(new Error('btn-toggle-key missing'), doc);
    assert.equal(nodes.length, 1);
    assert.match(banner.textContent, /btn-toggle-key missing/);
});
