/** Shared engine/mode helpers — no DOM or Tauri imports. */

export const SUPPORTED_MODES = ['automatic', 'assemblyai', 'groq', 'cloudflare', 'local'];
export const LEGACY_MODES = ['soniox', 'openai', 'qwen', 'standard'];

export const REQUIRED_INIT_IDS = [
    'btn-settings',
    'btn-back',
    'btn-start',
    'btn-close',
    'btn-pin',
    'transcript-content',
    'select-translation-mode',
    'input-groq-key',
    'input-cloudflare-account-id',
    'input-cloudflare-token',
    'input-assemblyai-key',
    'engine-pill',
];

export const SECRET_SETTING_KEYS = [
    'groq_api_key',
    'cloudflare_api_token',
    'cloudflare_account_id',
    'soniox_api_key',
    'openai_api_key',
    'qwen_api_key',
    'elevenlabs_api_key',
    'google_tts_api_key',
    'google_free_api_key',
    'tiktok_session_id',
    'assemblyai_api_key',
    'azure_translator_key',
    'gemini_api_key',
    'streaming_token',
    'temporary_token',
];

export function migrateTranslationMode(mode) {
    if (SUPPORTED_MODES.includes(mode)) return mode;
    return 'groq';
}

export function engineClassFromMode(mode) {
    const normalized = migrateTranslationMode(mode);
    if (normalized === 'automatic') return 'automatic';
    if (normalized === 'assemblyai') return 'assemblyai';
    return normalized;
}

export function nextModeForEngineClass(klass, currentMode) {
    if (SUPPORTED_MODES.includes(klass)) return klass;
    return migrateTranslationMode(currentMode);
}

export function missingRequiredIds(doc, ids = REQUIRED_INIT_IDS) {
    if (!doc || typeof doc.getElementById !== 'function') {
        return [...ids];
    }
    return ids.filter((id) => !doc.getElementById(id));
}

export function redactSettings(settings) {
    if (!settings || typeof settings !== 'object') return {};
    const out = { ...settings };
    for (const key of SECRET_SETTING_KEYS) {
        if (key in out && out[key]) out[key] = '[redacted]';
    }
    for (const key of Object.keys(out)) {
        if (/token|api_key|authorization|account_id|subscription_key/i.test(key) && out[key] && out[key] !== '[redacted]') {
            out[key] = '[redacted]';
        }
    }
    return out;
}

export function createSingleFlightFallback(startCloudflare) {
    let inFlight = false;
    return async function transitionToCloudflare() {
        if (inFlight) return { started: false };
        inFlight = true;
        try {
            await startCloudflare();
            return { started: true };
        } finally {
            inFlight = false;
        }
    };
}

export function applyStartFailure(state) {
    state.isRunning = false;
    state.isStarting = false;
    return state;
}

export function applyStartSuccess(state) {
    state.isRunning = true;
    state.isStarting = false;
    return state;
}

export function clientConfigFromSettings(settings, mode = 'groq') {
    const isCf = mode === 'cloudflare';
    return {
        sourceLanguage: settings.source_language || settings.sourceLang || 'auto',
        targetLanguage: settings.target_language || settings.targetLang || 'vi',
        apiKey: settings.groq_api_key || '',
        accountId: settings.cloudflare_account_id || '',
        apiToken: settings.cloudflare_api_token || '',
        sttModel: isCf
            ? (settings.cloudflare_stt_model || '@cf/openai/whisper-large-v3-turbo')
            : (settings.groq_stt_model || 'whisper-large-v3-turbo'),
        llmModel: isCf
            ? (settings.cloudflare_llm_model || '@cf/meta/llama-3.1-8b-instruct-fp8-fast')
            : (settings.groq_llm_model || 'openai/gpt-oss-120b'),
        llmProvider: settings.llm_provider || 'automatic',
        assemblyaiApiKey: settings.assemblyai_api_key || '',
        assemblyaiRegion: 'global',
        assemblyaiModel: settings.assemblyai_streaming_model || 'universal-streaming-english',
        assemblyaiSpeakerLabels: !!settings.assemblyai_speaker_labels,
        assemblyaiMedical: !!settings.assemblyai_medical,
        assemblyaiRedactPii: !!settings.assemblyai_redact_pii,
        assemblyaiFilterProfanity: !!settings.assemblyai_filter_profanity,
        assemblyaiMinTurnSilenceMs: settings.assemblyai_min_turn_silence_ms ?? 400,
        assemblyaiMaxTurnSilenceMs: settings.assemblyai_max_turn_silence_ms ?? 1280,
        assemblyaiVadThreshold: settings.assemblyai_vad_threshold ?? 0.4,
        assemblyaiEndOfTurnConfidence: settings.assemblyai_end_of_turn_confidence ?? 0.4,
    };
}

export function showFatalInitError(err, doc = typeof document !== 'undefined' ? document : null) {
    const msg = err?.message || String(err);
    if (typeof console !== 'undefined') console.error('[App] Fatal init error:', msg);
    if (!doc?.body) return msg;
    let banner = doc.getElementById('fatal-init-error');
    if (!banner) {
        banner = doc.createElement('div');
        banner.id = 'fatal-init-error';
        banner.setAttribute(
            'style',
            'position:fixed;inset:0;z-index:99999;background:#1c1917;color:#fafaf9;padding:28px;font:15px/1.5 Georgia,serif',
        );
        doc.body.prepend(banner);
    }
    banner.textContent = `App failed to start: ${msg}`;
    return msg;
}
