import { test } from 'node:test';
import assert from 'node:assert/strict';

function migrateJsDefaults(saved) {
    const defaults = {
        groq_enabled: true,
        cloudflare_enabled: true,
        assemblyai_enabled: true,
        assemblyai_api_key: '',
        assemblyai_region: 'global',
        assemblyai_streaming_model: 'universal-streaming-english',
        assemblyai_speaker_labels: false,
        azure_translator_enabled: false,
        azure_translator_key: '',
        gemini_enabled: false,
        gemini_api_key: '',
        gemini_model: 'gemini-3.1-flash-lite',
        ollama_enabled: false,
        ollama_base_url: 'http://127.0.0.1:11434',
        ollama_model: '',
        local_stt_enabled: false,
        translation_mode: 'automatic',
        groq_api_key: '',
        target_language: 'vi',
    };
    return { ...defaults, ...saved };
}

test('settings round-trip preserves AssemblyAI, Azure, Gemini, Ollama, and existing fields', () => {
    const saved = {
        groq_api_key: 'gsk_keep',
        cloudflare_account_id: 'acct_keep',
        assemblyai_api_key: 'aai_keep',
        assemblyai_region: 'us',
        assemblyai_streaming_model: 'whisper-rt',
        assemblyai_speaker_labels: true,
        azure_translator_enabled: true,
        azure_translator_key: 'az_keep',
        gemini_enabled: true,
        gemini_api_key: 'gem_keep',
        gemini_model: 'gemini-3.1-flash-lite',
        ollama_enabled: true,
        ollama_model: 'qwen2.5:7b',
        translation_mode: 'assemblyai',
        target_language: 'ro',
    };
    const loaded = migrateJsDefaults(saved);
    const json = JSON.stringify(loaded);
    const back = JSON.parse(json);
    assert.equal(back.assemblyai_api_key, 'aai_keep');
    assert.equal(back.assemblyai_region, 'us');
    assert.equal(back.azure_translator_key, 'az_keep');
    assert.equal(back.gemini_api_key, 'gem_keep');
    assert.equal(back.ollama_model, 'qwen2.5:7b');
    assert.equal(back.groq_api_key, 'gsk_keep');
    assert.equal(back.translation_mode, 'assemblyai');
    assert.equal(back.target_language, 'ro');
});

test('legacy settings migrate without dropping credentials', () => {
    const legacy = {
        translation_mode: 'soniox',
        groq_api_key: 'gsk_old',
        target_language: 'vi',
    };
    const loaded = migrateJsDefaults(legacy);
    assert.equal(loaded.groq_api_key, 'gsk_old');
    assert.equal(loaded.assemblyai_region, 'global');
    assert.equal(loaded.gemini_enabled, false);
    assert.equal(loaded.ollama_base_url, 'http://127.0.0.1:11434');
});
