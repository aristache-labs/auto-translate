/**
 * App settings form, engine picker, API key test, and chain UI.
 * Mixed onto App.prototype from app.js.
 */

import { settingsManager } from './settings.js';
import {
    getEffectiveSTTChain,
    getEffectiveTranslationChain,
    resetAllCircuitBreakers,
    getCircuitBreakerStatuses,
    migrateLlmProvider,
} from './provider-orchestrator.js';
import { ollamaTranslator } from './ollama-translator.js';
import {
    migrateTranslationMode,
    engineClassFromMode,
    nextModeForEngineClass,
} from './mode-utils.js';

const { invoke } = window.__TAURI__.core;

export const appSettingsMethods = {


    _bindSettingsFormEvents() {
        this._bindSettingsForm();

        document.getElementById('settings-view')?.addEventListener('mousedown', (e) => {
            const interactive = e.target.closest('button, input, select, label, a, textarea, .settings-section, .settings-actions');
            if (!interactive && e.buttons === 1) {
                e.preventDefault();
                this.appWindow.startDragging();
            }
        });

        this._on('btn-toggle-assemblyai-key', 'click', () => {
            const input = document.getElementById('input-assemblyai-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
        this._on('btn-toggle-groq-key', 'click', () => {
            const input = document.getElementById('input-groq-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
        this._on('btn-toggle-cloudflare-account', 'click', () => {
            const input = document.getElementById('input-cloudflare-account-id');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
        this._on('btn-toggle-openrouter-key', 'click', () => {
            const input = document.getElementById('input-openrouter-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
        this._on('link-openrouter', 'click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://openrouter.ai/keys');
        });
        this._on('input-openrouter-key', 'input', () => this._refreshKeyStatus());
        this._on('btn-test-openrouter', 'click', () => this._testConnection('openrouter'));
        this._on('select-llm-provider', 'change', () => this._updateLlmProviderUI());
        this._on('check-llm-fallback', 'change', () => this._updateChainUI());
        this._on('btn-toggle-cloudflare-token', 'click', () => {
            const input = document.getElementById('input-cloudflare-token');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
        this._on('btn-toggle-azure-key', 'click', () => {
            const input = document.getElementById('input-azure-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
        this._on('btn-toggle-gemini-key', 'click', () => {
            const input = document.getElementById('input-gemini-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
        this._on('btn-test-azure', 'click', () => this._testConnection('azure'));
        this._on('btn-test-gemini', 'click', () => this._testConnection('gemini'));
        this._on('btn-test-ollama', 'click', () => this._testConnection('ollama'));
        this._on('btn-test-assemblyai', 'click', () => this._testConnection('assemblyai'));
        this._on('btn-reset-circuit-breaker', 'click', () => {
            resetAllCircuitBreakers();
            this._showToast('Circuit breakers reset', 'success');
            this._updateChainUI();
        });

        const refreshChainInputs = [
            'input-openrouter-key', 'input-groq-key', 'input-cloudflare-account-id',
            'input-cloudflare-token', 'input-azure-key', 'check-azure-enabled',
            'input-gemini-key', 'check-gemini-enabled', 'input-ollama-model',
            'check-ollama-enabled', 'input-assemblyai-key', 'check-assemblyai-enabled',
            'select-translation-mode', 'select-llm-provider', 'check-llm-fallback'
        ];
        refreshChainInputs.forEach(id => {
            this._on(id, 'change', () => this._updateChainUI());
            this._on(id, 'input', () => this._updateChainUI());
        });

        this._on('link-groq', 'click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://console.groq.com/keys');
        });
        this._on('link-cloudflare-dashboard', 'click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://dash.cloudflare.com');
        });
        this._on('link-cloudflare-tokens', 'click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://dash.cloudflare.com/profile/api-tokens');
        });

        this._on('input-groq-key', 'input', () => this._refreshKeyStatus());
        this._on('input-cloudflare-account-id', 'input', () => this._refreshKeyStatus());
        this._on('input-cloudflare-token', 'input', () => this._refreshKeyStatus());
        this._on('btn-test-groq', 'click', () => this._testConnection('groq'));
        this._on('btn-test-cloudflare', 'click', () => this._testConnection('cloudflare'));
        this._on('input-assemblyai-key', 'input', () => this._refreshKeyStatus());

        document.getElementById('select-translation-mode').addEventListener('change', (e) => {
            this._updateModeUI(e.target.value);
        });

        this._on('select-translation-type', 'change', (e) => {
            this._updateTranslationTypeUI(e.target.value);
        });

        this._on('link-elevenlabs', 'click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://elevenlabs.io/app/sign-up');
        });

        // Save settings — both top and bottom buttons
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            this._saveSettingsFromForm();
        });
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => {
            this._saveSettingsFromForm();
        });

        // Slider live updates
        document.getElementById('range-opacity').addEventListener('input', (e) => {
            document.getElementById('opacity-value').textContent = `${e.target.value}%`;
        });

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = `${e.target.value}px`;
        });

        document.getElementById('range-max-lines').addEventListener('input', (e) => {
            document.getElementById('max-lines-value').textContent = e.target.value;
        });

        document.getElementById('range-endpoint-delay')?.addEventListener('input', (e) => {
            document.getElementById('endpoint-delay-value').textContent = `${(e.target.value / 1000).toFixed(1)}s`;
        });
        const bindAaiRange = (id, valueId, fmt) => {
            document.getElementById(id)?.addEventListener('input', (e) => {
                const out = document.getElementById(valueId);
                if (out) out.textContent = fmt(e.target.value);
            });
        };
        bindAaiRange('range-assemblyai-min-silence', 'assemblyai-min-silence-value', (v) => `${v}ms`);
        bindAaiRange('range-assemblyai-max-silence', 'assemblyai-max-silence-value', (v) => `${v}ms`);
        bindAaiRange('range-assemblyai-vad', 'assemblyai-vad-value', (v) => Number(v).toFixed(2));
        bindAaiRange('range-assemblyai-eot', 'assemblyai-eot-value', (v) => Number(v).toFixed(2));

        // Toggle ElevenLabs API key visibility
        document.getElementById('btn-toggle-elevenlabs-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-elevenlabs-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-tts-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-free-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-free-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Settings wizard navigation: home cards open detail screens, back rows return home
        document.querySelectorAll('.settings-card, .settings-back-row').forEach(el => {
            el.addEventListener('click', () => {
                if (el.classList.contains('disabled')) return;
                this._showSettingsScreen(el.dataset.screen);
            });
        });

        // TTS enable/disable toggle in settings — show/hide detail
        document.getElementById('check-tts-enabled')?.addEventListener('change', (e) => {
            const detail = document.getElementById('tts-settings-detail');
            if (detail) detail.style.display = e.target.checked ? '' : 'none';
        });

        // TTS provider toggle — show/hide relevant settings panels
        document.getElementById('select-tts-provider')?.addEventListener('change', (e) => {
            this._updateTTSProviderUI(e.target.value);
        });

        // TTS speed slider — show value
        document.getElementById('range-tts-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tts-speed-value');
            if (label) label.textContent = e.target.value + 'x';
        });

        // Edge TTS speed slider
        document.getElementById('range-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        document.getElementById('range-google-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Microsoft v2 speed slider
        document.getElementById('range-microsoft-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('microsoft-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        // Microsoft v2 language filter — re-fill the voice dropdown for the chosen language
        document.getElementById('select-microsoft-lang')?.addEventListener('change', (e) => {
            this._fillMicrosoftVoices(e.target.value);
        });

        // Local offline: language filter re-renders the voice list
        document.getElementById('select-local-lang')?.addEventListener('change', (e) => {
            this._fillLocalVoices(e.target.value);
        });

        // Local offline: speed slider (0.5x–2.0x)
        document.getElementById('range-local-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('local-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Google-free / TikTok: client-side speed sliders (0.5x–2.0x)
        document.getElementById('range-google-free-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-free-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });
        document.getElementById('range-tiktok-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tiktok-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Local offline: change model storage folder
        document.getElementById('btn-local-change-dir')?.addEventListener('click', () => {
            this._maybePickModelsDir();
        });

        // Local offline: reset model folder back to the default app location
        document.getElementById('btn-local-reset-dir')?.addEventListener('click', () => {
            this._resetModelsDir();
        });

        // TikTok: paste a "Copy as cURL" and auto-extract the sessionid cookie into the field
        document.getElementById('input-tiktok-curl')?.addEventListener('input', (e) => {
            const m = e.target.value.match(/sessionid=([^;"'\s\\]+)/i);
            const sidInput = document.getElementById('input-tiktok-session');
            if (m && m[1] && sidInput && sidInput.value !== m[1]) {
                sidInput.value = m[1];
                this._showToast('sessionid extracted from cURL ✓', 'success');
            }
        });

        // Add translation term row
        document.getElementById('btn-add-term')?.addEventListener('click', () => {
            this._addTermRow('', '');
        });

        // Add general context row
        document.getElementById('btn-add-general')?.addEventListener('click', () => {
            this._addGeneralRow('', '');
        });

    },


    _bindEnginePicker() {
        document.querySelectorAll('#engine-picker .engine-card').forEach(card => {
            card.addEventListener('click', () => {
                this._selectEngineClass(card.dataset.engineClass);
                this._hideEnginePicker();
            });
        });
        document.querySelectorAll('#engine-pill .engine-pill-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.isRunning || this.isStarting) {
                    this._showToast('Pause the session before switching engine', 'error');
                    return;
                }
                this._selectEngineClass(btn.dataset.engineClass);
            });
        });
    },


    _bindSettingsForm() {
        // These are handled in _populateSettingsForm and _saveSettingsFromForm
    },


    // ─── Settings Form ─────────────────────────────────────

    _populateSettingsForm() {
        const s = settingsManager.get();

        const groqKey = document.getElementById('input-groq-key');
        if (groqKey) groqKey.value = s.groq_api_key || '';
        const cfAccount = document.getElementById('input-cloudflare-account-id');
        if (cfAccount) cfAccount.value = s.cloudflare_account_id || '';
        const cfToken = document.getElementById('input-cloudflare-token');
        if (cfToken) cfToken.value = s.cloudflare_api_token || '';
        this._setSelectValue('select-groq-stt-model', s.groq_stt_model || 'whisper-large-v3-turbo');
        this._setSelectValue('select-groq-llm-model', s.groq_llm_model || 'openai/gpt-oss-120b');
        this._setSelectValue('select-cloudflare-stt-model', s.cloudflare_stt_model || '@cf/openai/whisper-large-v3-turbo');
        this._setSelectValue('select-cloudflare-llm-model', s.cloudflare_llm_model || '@cf/meta/llama-3.1-8b-instruct-fast');
        const orKey = document.getElementById('input-openrouter-key');
        if (orKey) orKey.value = s.openrouter_api_key || '';
        this._setSelectValue('select-llm-provider', migrateLlmProvider(s.llm_provider));
        const llmFallback = document.getElementById('check-llm-fallback');
        if (llmFallback) llmFallback.checked = s.llm_fallback !== false;
        const orModel = document.getElementById('input-openrouter-llm-model');
        if (orModel) orModel.value = s.openrouter_llm_model || 'openai/gpt-4o-mini';

        // Azure Translator Text
        const azEnabled = document.getElementById('check-azure-enabled');
        if (azEnabled) azEnabled.checked = s.azure_translator_enabled || false;
        const azKey = document.getElementById('input-azure-key');
        if (azKey) azKey.value = s.azure_translator_key || '';
        const azRegion = document.getElementById('input-azure-region');
        if (azRegion) azRegion.value = s.azure_translator_region || '';
        const azEndpoint = document.getElementById('input-azure-endpoint');
        if (azEndpoint) azEndpoint.value = s.azure_translator_endpoint || 'https://api.cognitive.microsofttranslator.com';

        // Gemini
        const gemEnabled = document.getElementById('check-gemini-enabled');
        if (gemEnabled) gemEnabled.checked = s.gemini_enabled || false;
        const gemKey = document.getElementById('input-gemini-key');
        if (gemKey) gemKey.value = s.gemini_api_key || '';
        this._setSelectValue('select-gemini-model', s.gemini_model || 'gemini-3.1-flash-lite');

        // Ollama
        const olEnabled = document.getElementById('check-ollama-enabled');
        if (olEnabled) olEnabled.checked = s.ollama_enabled || false;
        const olUrl = document.getElementById('input-ollama-url');
        if (olUrl) olUrl.value = s.ollama_base_url || 'http://127.0.0.1:11434';
        const olModel = document.getElementById('input-ollama-model');
        if (olModel) olModel.value = s.ollama_model || '';

        const aaiEnabled = document.getElementById('check-assemblyai-enabled');
        if (aaiEnabled) aaiEnabled.checked = s.assemblyai_enabled !== false;
        const aaiKey = document.getElementById('input-assemblyai-key');
        if (aaiKey) aaiKey.value = s.assemblyai_api_key || '';
        this._setSelectValue('select-assemblyai-model', s.assemblyai_streaming_model || 'universal-streaming-english');
        const aaiSpeakers = document.getElementById('check-assemblyai-speaker-labels');
        if (aaiSpeakers) aaiSpeakers.checked = !!s.assemblyai_speaker_labels;
        const aaiMedical = document.getElementById('check-assemblyai-medical');
        if (aaiMedical) aaiMedical.checked = !!s.assemblyai_medical;
        const aaiPii = document.getElementById('check-assemblyai-redact-pii');
        if (aaiPii) aaiPii.checked = !!s.assemblyai_redact_pii;
        const aaiProfanity = document.getElementById('check-assemblyai-filter-profanity');
        if (aaiProfanity) aaiProfanity.checked = !!s.assemblyai_filter_profanity;
        const minSilence = s.assemblyai_min_turn_silence_ms ?? 400;
        const maxSilence = s.assemblyai_max_turn_silence_ms ?? 1280;
        const minEl = document.getElementById('range-assemblyai-min-silence');
        if (minEl) minEl.value = minSilence;
        const minVal = document.getElementById('assemblyai-min-silence-value');
        if (minVal) minVal.textContent = `${minSilence}ms`;
        const maxEl = document.getElementById('range-assemblyai-max-silence');
        if (maxEl) maxEl.value = maxSilence;
        const maxVal = document.getElementById('assemblyai-max-silence-value');
        if (maxVal) maxVal.textContent = `${maxSilence}ms`;
        const vad = s.assemblyai_vad_threshold ?? 0.4;
        const vadEl = document.getElementById('range-assemblyai-vad');
        if (vadEl) vadEl.value = vad;
        const vadVal = document.getElementById('assemblyai-vad-value');
        if (vadVal) vadVal.textContent = Number(vad).toFixed(2);
        const eot = s.assemblyai_end_of_turn_confidence ?? 0.4;
        const eotEl = document.getElementById('range-assemblyai-eot');
        if (eotEl) eotEl.value = eot;
        const eotVal = document.getElementById('assemblyai-eot-value');
        if (eotVal) eotVal.textContent = Number(eot).toFixed(2);

        this._updateLlmProviderUI();
        this._updateChainUI();
        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';
        const mode = migrateTranslationMode(s.translation_mode);
        document.getElementById('select-translation-mode').value = mode;
        this._updateModeUI(mode);
        this._refreshKeyStatus();

        // Translation type (one-way / two-way)
        const translationType = s.translation_type || 'one_way';
        document.getElementById('select-translation-type').value = translationType;
        this._updateTranslationTypeUI(translationType);

        // Two-way language selects
        document.getElementById('select-lang-a').value = s.language_a || 'ja';
        document.getElementById('select-lang-b').value = s.language_b || 'vi';

        // Strict language detection
        document.getElementById('check-strict-lang').checked = s.language_hints_strict || false;

        // Endpoint delay
        const endpointDelay = s.endpoint_delay || 3000;
        const delaySlider = document.getElementById('range-endpoint-delay');
        if (delaySlider) delaySlider.value = endpointDelay;
        const delayValue = document.getElementById('endpoint-delay-value');
        if (delayValue) delayValue.textContent = `${(endpointDelay / 1000).toFixed(1)}s`;

        // Audio source radio
        const radioValue = s.audio_source || 'system';
        const radio = document.querySelector(`input[name="audio-source"][value="${radioValue}"]`);
        if (radio) radio.checked = true;

        // Display
        const opacityPercent = Math.round((s.overlay_opacity || 0.85) * 100);
        document.getElementById('range-opacity').value = opacityPercent;
        document.getElementById('opacity-value').textContent = `${opacityPercent}%`;

        document.getElementById('range-font-size').value = s.font_size || 16;
        document.getElementById('font-size-value').textContent = `${s.font_size || 16}px`;

        document.getElementById('range-max-lines').value = s.max_lines || 5;
        document.getElementById('max-lines-value').textContent = s.max_lines || 5;

        document.getElementById('check-show-original').checked = s.show_original !== false;

        // Custom context (rich format)
        const ctx = s.custom_context;
        // General context rows
        const generalList = document.getElementById('context-general-list');
        if (generalList) {
            generalList.innerHTML = '';
            const generalPairs = ctx?.general || [];
            generalPairs.forEach(g => this._addGeneralRow(g.key, g.value));
        }
        // Transcription terms
        const termsInput = document.getElementById('input-context-terms');
        if (termsInput) {
            termsInput.value = (ctx?.terms || []).join('\n');
        }
        // Background text
        const textInput = document.getElementById('input-context-text');
        if (textInput) {
            textInput.value = ctx?.text || '';
        }
        // Load translation terms as rows
        const termsList = document.getElementById('translation-terms-list');
        if (termsList) {
            termsList.innerHTML = '';
            const terms = ctx?.translation_terms || [];
            terms.forEach(t => this._addTermRow(t.source, t.target));
        }

        // TTS settings
        document.getElementById('input-elevenlabs-key').value = s.elevenlabs_api_key || '';
        document.getElementById('select-tts-voice').value = s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
        // Edge TTS settings
        const edgeVoiceSelect = document.getElementById('select-edge-voice');
        if (edgeVoiceSelect) edgeVoiceSelect.value = s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const edgeSpeedSlider = document.getElementById('range-edge-speed');
        const edgeSpeedLabel = document.getElementById('edge-speed-value');
        const edgeSpeed = s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20;
        if (edgeSpeedSlider) edgeSpeedSlider.value = edgeSpeed;
        if (edgeSpeedLabel) edgeSpeedLabel.textContent = (edgeSpeed >= 0 ? '+' : '') + edgeSpeed + '%';

        // Google TTS settings
        const googleKeyInput = document.getElementById('input-google-tts-key');
        if (googleKeyInput) googleKeyInput.value = s.google_tts_api_key || '';
        const googleVoiceSelect = document.getElementById('select-google-voice');
        if (googleVoiceSelect) googleVoiceSelect.value = s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        const googleSpeedSlider = document.getElementById('range-google-speed');
        const googleSpeedLabel = document.getElementById('google-speed-value');
        const googleSpeed = s.google_tts_speed || 1.0;
        if (googleSpeedSlider) googleSpeedSlider.value = googleSpeed;
        if (googleSpeedLabel) googleSpeedLabel.textContent = googleSpeed + 'x';

        // Microsoft v2 settings (voice populated dynamically in _updateTTSProviderUI)
        const msVoiceSelect = document.getElementById('select-microsoft-voice');
        if (msVoiceSelect) msVoiceSelect.value = s.microsoft_v2_voice || 'vi-VN-HoaiMyNeural';
        const msSpeedSlider = document.getElementById('range-microsoft-speed');
        const msSpeedLabel = document.getElementById('microsoft-speed-value');
        const msSpeed = s.microsoft_v2_speed !== undefined ? s.microsoft_v2_speed : 20;
        if (msSpeedSlider) msSpeedSlider.value = msSpeed;
        if (msSpeedLabel) msSpeedLabel.textContent = (msSpeed >= 0 ? '+' : '') + msSpeed + '%';

        // Google Free settings
        const gfKeyInput = document.getElementById('input-google-free-key');
        if (gfKeyInput) gfKeyInput.value = s.google_free_api_key || '';
        const gfVoiceSelect = document.getElementById('select-google-free-voice');
        if (gfVoiceSelect) gfVoiceSelect.value = s.google_free_voice || 'vi-VN';
        const gfSpeed = s.google_free_speed || 1.0;
        const gfSpeedSlider = document.getElementById('range-google-free-speed');
        const gfSpeedLabel = document.getElementById('google-free-speed-value');
        if (gfSpeedSlider) gfSpeedSlider.value = gfSpeed;
        if (gfSpeedLabel) gfSpeedLabel.textContent = parseFloat(gfSpeed).toFixed(1) + 'x';

        // TikTok settings
        const ttVoiceSelect = document.getElementById('select-tiktok-voice');
        if (ttVoiceSelect) ttVoiceSelect.value = s.tiktok_voice || 'BV074_streaming';
        const ttSession = document.getElementById('input-tiktok-session');
        if (ttSession) ttSession.value = s.tiktok_session_id || '';
        const ttSpeed = s.tiktok_speed || 1.0;
        const ttSpeedSlider = document.getElementById('range-tiktok-speed');
        const ttSpeedLabel = document.getElementById('tiktok-speed-value');
        if (ttSpeedSlider) ttSpeedSlider.value = ttSpeed;
        if (ttSpeedLabel) ttSpeedLabel.textContent = parseFloat(ttSpeed).toFixed(1) + 'x';

        // TTS provider
        const providerSelect = document.getElementById('select-tts-provider');
        if (providerSelect) {
            providerSelect.value = s.tts_provider || 'edge';
            this._updateTTSProviderUI(providerSelect.value);
        }
    },


    async _saveSettingsFromForm() {
        const settings = {
            groq_api_key: document.getElementById('input-groq-key')?.value.trim() || '',
            groq_stt_model: document.getElementById('select-groq-stt-model')?.value || 'whisper-large-v3-turbo',
            groq_llm_model: document.getElementById('select-groq-llm-model')?.value || 'openai/gpt-oss-120b',
            cloudflare_account_id: document.getElementById('input-cloudflare-account-id')?.value.trim() || '',
            cloudflare_api_token: document.getElementById('input-cloudflare-token')?.value.trim() || '',
            cloudflare_stt_model: document.getElementById('select-cloudflare-stt-model')?.value || '@cf/openai/whisper-large-v3-turbo',
            cloudflare_llm_model: document.getElementById('select-cloudflare-llm-model')?.value || '@cf/meta/llama-3.1-8b-instruct-fast',
            llm_provider: migrateLlmProvider(document.getElementById('select-llm-provider')?.value),
            llm_fallback: document.getElementById('check-llm-fallback')?.checked !== false,
            openrouter_api_key: document.getElementById('input-openrouter-key')?.value.trim() || '',
            openrouter_llm_model: document.getElementById('input-openrouter-llm-model')?.value.trim() || 'openai/gpt-4o-mini',
            azure_translator_enabled: document.getElementById('check-azure-enabled')?.checked || false,
            azure_translator_key: document.getElementById('input-azure-key')?.value.trim() || '',
            azure_translator_region: document.getElementById('input-azure-region')?.value.trim() || '',
            azure_translator_endpoint: document.getElementById('input-azure-endpoint')?.value.trim() || 'https://api.cognitive.microsofttranslator.com',
            gemini_enabled: document.getElementById('check-gemini-enabled')?.checked || false,
            gemini_api_key: document.getElementById('input-gemini-key')?.value.trim() || '',
            gemini_model: document.getElementById('select-gemini-model')?.value || 'gemini-3.1-flash-lite',
            ollama_enabled: document.getElementById('check-ollama-enabled')?.checked || false,
            ollama_base_url: document.getElementById('input-ollama-url')?.value.trim() || 'http://127.0.0.1:11434',
            ollama_model: document.getElementById('input-ollama-model')?.value.trim() || '',
            assemblyai_enabled: document.getElementById('check-assemblyai-enabled')?.checked !== false,
            assemblyai_api_key: document.getElementById('input-assemblyai-key')?.value.trim() || '',
            assemblyai_region: 'global',
            assemblyai_streaming_model: document.getElementById('select-assemblyai-model')?.value || 'universal-streaming-english',
            assemblyai_speaker_labels: document.getElementById('check-assemblyai-speaker-labels')?.checked || false,
            assemblyai_medical: document.getElementById('check-assemblyai-medical')?.checked || false,
            assemblyai_redact_pii: document.getElementById('check-assemblyai-redact-pii')?.checked || false,
            assemblyai_filter_profanity: document.getElementById('check-assemblyai-filter-profanity')?.checked || false,
            assemblyai_min_turn_silence_ms: parseInt(document.getElementById('range-assemblyai-min-silence')?.value || 400, 10),
            assemblyai_max_turn_silence_ms: parseInt(document.getElementById('range-assemblyai-max-silence')?.value || 1280, 10),
            assemblyai_vad_threshold: parseFloat(document.getElementById('range-assemblyai-vad')?.value || 0.4),
            assemblyai_end_of_turn_confidence: parseFloat(document.getElementById('range-assemblyai-eot')?.value || 0.4),
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            translation_mode: migrateTranslationMode(document.getElementById('select-translation-mode').value),
            translation_type: document.getElementById('select-translation-type')?.value || 'one_way',
            language_a: document.getElementById('select-lang-a')?.value || 'ja',
            language_b: document.getElementById('select-lang-b')?.value || 'vi',
            language_hints_strict: document.getElementById('check-strict-lang')?.checked || false,
            endpoint_delay: parseInt(document.getElementById('range-endpoint-delay')?.value || 3000),
            audio_source: document.querySelector('input[name="audio-source"]:checked')?.value || 'system',
            overlay_opacity: parseInt(document.getElementById('range-opacity').value) / 100,
            font_size: parseInt(document.getElementById('range-font-size').value),
            max_lines: parseInt(document.getElementById('range-max-lines').value),
            show_original: document.getElementById('check-show-original').checked,
            custom_context: null,
        };

        // Parse custom context (rich format)
        // General key-value pairs
        const generalPairs = [];
        document.querySelectorAll('#context-general-list .general-row').forEach(row => {
            const key = row.querySelector('.general-key')?.value.trim();
            const value = row.querySelector('.general-value')?.value.trim();
            if (key && value) generalPairs.push({ key, value });
        });

        // Transcription terms
        const termsRaw = document.getElementById('input-context-terms')?.value.trim() || '';
        const terms = termsRaw ? termsRaw.split('\n').map(t => t.trim()).filter(t => t) : [];

        // Background text
        const contextText = document.getElementById('input-context-text')?.value.trim() || '';

        // Translation terms
        const translationTerms = [];
        document.querySelectorAll('#translation-terms-list .term-row').forEach(row => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) translationTerms.push({ source, target });
        });

        if (generalPairs.length > 0 || terms.length > 0 || contextText || translationTerms.length > 0) {
            settings.custom_context = {
                general: generalPairs,
                terms: terms,
                text: contextText || null,
                translation_terms: translationTerms,
            };
        }

        // TTS settings
        settings.tts_provider = document.getElementById('select-tts-provider')?.value || 'edge';
        settings.elevenlabs_api_key = document.getElementById('input-elevenlabs-key').value.trim();
        settings.tts_voice_id = document.getElementById('select-tts-voice').value;
        settings.edge_tts_voice = document.getElementById('select-edge-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.edge_tts_speed = parseInt(document.getElementById('range-edge-speed')?.value || 20);
        settings.tts_speed = parseFloat(document.getElementById('range-tts-speed')?.value || 1.2);
        settings.google_tts_api_key = document.getElementById('input-google-tts-key')?.value.trim() || '';
        settings.google_tts_voice = document.getElementById('select-google-voice')?.value || 'vi-VN-Chirp3-HD-Aoede';
        settings.google_tts_speed = parseFloat(document.getElementById('range-google-speed')?.value || 1.0);
        settings.microsoft_v2_voice = document.getElementById('select-microsoft-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.microsoft_v2_speed = parseInt(document.getElementById('range-microsoft-speed')?.value || 20);
        settings.google_free_api_key = document.getElementById('input-google-free-key')?.value.trim() || '';
        settings.google_free_voice = document.getElementById('select-google-free-voice')?.value || 'vi-VN';
        settings.google_free_speed = parseFloat(document.getElementById('range-google-free-speed')?.value || 1.0);
        settings.tiktok_voice = document.getElementById('select-tiktok-voice')?.value || 'BV074_streaming';
        settings.tiktok_speed = parseFloat(document.getElementById('range-tiktok-speed')?.value || 1.0);
        settings.tiktok_session_id = document.getElementById('input-tiktok-session')?.value.trim() || '';
        settings.local_tts_speed = parseFloat(document.getElementById('range-local-speed')?.value || 1.0);
        settings.tts_enabled = false;

        try {
            await settingsManager.save(settings);
            this._showToast('Settings saved', 'success');
            this._showView('overlay');
        } catch (err) {
            this._showToast(`Failed to save: ${err}`, 'error');
        }
    },


    // ─── Apply Settings ────────────────────────────────────

    _applySettings(settings) {
        // Update overlay opacity
        const overlayView = document.getElementById('overlay-view');
        overlayView.style.opacity = settings.overlay_opacity || 0.85;

        // Live status row: language pair display
        const langEl = document.getElementById('live-lang');
        if (langEl) {
            langEl.textContent = `${settings.source_language || 'auto'} → ${settings.target_language || 'vi'}`;
        }

        // Note: saving settings turns TTS narration off (see end of this method), so the
        // active provider is re-configured on the next TTS toggle — no mid-session re-sync
        // needed here. Disconnect any non-active provider to drop stale queued audio.
        if (this._allTTS) {
            const active = this._getActiveTTS();
            for (const tts of this._allTTS) {
                if (tts !== active && tts.isConnected) tts.disconnect();
            }
        }

        // Update transcript UI
        if (this.transcriptUI) {
            this.transcriptUI.configure({
                maxLines: settings.max_lines || 5,
                showOriginal: settings.show_original !== false,
                fontSize: settings.font_size || 16,
                sourceLanguage: settings.source_language || 'auto',
                targetLanguage: settings.target_language || 'vi',
            });
        }

        // Update current source button states
        this.currentSource = settings.audio_source || 'system';
        this._updateSourceButtons();

        // TTS is always OFF on app start — user must toggle on each session
        this.ttsEnabled = false;
        this._updateTTSButton();
    },


    // ─── Engine picker (Standard vs OpenAI) ──────────────────
    // OpenAI Realtime is structurally different (text+voice fused, no two-way,
    // no custom TTS), so we surface the choice as a top-level decision rather
    // than burying it in Settings. "Standard" represents the Soniox/Local pair
    // — they share the same UX shape (text-only, optional TTS, two-way, etc.).

    _engineClassFromMode(mode) {
        return engineClassFromMode(mode);
    },


    _selectEngineClass(klass) {
        const settings = settingsManager.get();
        const currentMode = migrateTranslationMode(settings.translation_mode);
        const nextMode = nextModeForEngineClass(klass, currentMode);
        settingsManager.save({ translation_mode: nextMode });
        const select = document.getElementById('select-translation-mode');
        if (select) select.value = nextMode;
        this._updateModeUI(nextMode);
    },


    _updatePillState(mode) {
        const runtime = this.activeSttProvider || mode;
        const klass = runtime === 'local-stt' ? 'local' : runtime;
        document.querySelectorAll('#engine-pill .engine-pill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.engineClass === klass);
        });
    },


    _setEnginePillLocked(locked) {
        const pill = document.getElementById('engine-pill');
        if (!pill) return;
        pill.dataset.locked = locked ? 'true' : 'false';
        pill.querySelectorAll('.engine-pill-btn').forEach(btn => { btn.disabled = locked; });
    },


    _showEnginePicker() {
        const picker = document.getElementById('engine-picker');
        if (picker) picker.style.display = '';
        document.body.classList.add('app-picker-active');
    },


    _hideEnginePicker() {
        const picker = document.getElementById('engine-picker');
        if (picker) picker.style.display = 'none';
        this._enginePickerDismissed = true;
        document.body.classList.remove('app-picker-active');
    },


    _maybeShowEnginePicker() {
        // Show on each fresh launch until first dismissal (click on a card or
        // first Start). Once dismissed, the toolbar pill is the only switcher.
        if (this._enginePickerDismissed) return;
        if (this.isRunning || this.isStarting) return;
        if (this.transcriptUI && this.transcriptUI.hasContent()) return;
        this._showEnginePicker();
    },


    _updateModeUI(mode) {
        mode = migrateTranslationMode(mode);
        const isGroq = mode === 'groq';
        const isCloudflare = mode === 'cloudflare';
        const isLocal = mode === 'local';
        const isAssembly = mode === 'assemblyai';
        const isAutomatic = mode === 'automatic';
        const isCloudRealtime = false;
        this._updatePillState(this.activeSttProvider || mode);

        const hintAuto = document.getElementById('hint-mode-automatic');
        const hintAai = document.getElementById('hint-mode-assemblyai');
        const hintGroq = document.getElementById('hint-mode-groq');
        const hintCf = document.getElementById('hint-mode-cloudflare');
        const hintLocal = document.getElementById('hint-mode-local');
        if (hintAuto) hintAuto.style.display = isAutomatic ? '' : 'none';
        if (hintAai) hintAai.style.display = isAssembly ? '' : 'none';
        if (hintGroq) hintGroq.style.display = isGroq ? '' : 'none';
        if (hintCf) hintCf.style.display = isCloudflare ? '' : 'none';
        if (hintLocal) hintLocal.style.display = isLocal ? '' : 'none';

        const s = settingsManager.get();
        const localUnsupported = isLocal && !this.isAppleSilicon;
        const missingKey =
            (isGroq && !(s.groq_api_key || '').trim()) ? 'Groq' :
            (isCloudflare && (!(s.cloudflare_account_id || '').trim() || !(s.cloudflare_api_token || '').trim())) ? 'Cloudflare' :
            (isAssembly && !(s.assemblyai_api_key || '').trim()) ? 'AssemblyAI' : null;
        const activeHint = isAutomatic ? hintAuto : isAssembly ? hintAai : isGroq ? hintGroq : isCloudflare ? hintCf : hintLocal;
        if (activeHint) {
            activeHint.classList.toggle('hint-warning', localUnsupported || !!missingKey);
            if (localUnsupported) {
                activeHint.textContent = this._platformOs === 'macos'
                    ? '⚠️ Local MLX needs Apple Silicon — this Mac cannot run it; choose another engine.'
                    : '⚠️ Local MLX only runs on macOS Apple Silicon — choose another engine on this machine.';
            } else if (missingKey) {
                activeHint.textContent = `⚠️ ${missingKey} needs credentials — enter them below before starting.`;
            }
        }

        const sectionAai = document.getElementById('section-assemblyai-key');
        const sectionGroq = document.getElementById('section-groq-key');
        const sectionCf = document.getElementById('section-cloudflare-key');
        if (sectionAai) sectionAai.style.display = isLocal ? 'none' : '';
        if (sectionGroq) sectionGroq.style.display = isLocal ? 'none' : '';
        if (sectionCf) sectionCf.style.display = isLocal ? 'none' : '';
        this._updateLlmProviderUI();

        // Soniox-only features: Custom context, Strict language detection,
        // Endpoint delay. The realtime engines manage these internally.
        const sectionContext = document.getElementById('section-soniox-context');
        if (sectionContext) sectionContext.style.display = 'none';
        const sectionStrictLang = document.getElementById('section-strict-lang');
        if (sectionStrictLang) sectionStrictLang.style.display = 'none';
        const sectionEndpointDelay = document.getElementById('section-endpoint-delay');
        if (sectionEndpointDelay) sectionEndpointDelay.style.display = 'none';

        // Two-way mode incompatible with realtime translation engines — force
        // one-way + disable the option for any cloud-realtime mode.
        const typeSelect = document.getElementById('select-translation-type');
        if (typeSelect) {
            const twoWayOpt = typeSelect.querySelector('option[value="two_way"]');
            if (twoWayOpt) twoWayOpt.disabled = isCloudRealtime;
            if (isCloudRealtime && typeSelect.value === 'two_way') {
                typeSelect.value = 'one_way';
                this._updateTranslationTypeUI('one_way');
            }
        }

        // Custom TTS toggle: cloud realtime engines run text-only to prevent
        // the speaker → mic feedback loop on shared devices.
        const ttsCheck = document.getElementById('check-tts-enabled');
        if (ttsCheck) {
            ttsCheck.disabled = isCloudRealtime;
            if (isCloudRealtime) ttsCheck.checked = false;
            const ttsDetail = document.getElementById('tts-settings-detail');
            if (ttsDetail) ttsDetail.style.display = (isCloudRealtime || !ttsCheck.checked) ? 'none' : '';
        }
        const btnTts = document.getElementById('btn-tts');
        if (btnTts) btnTts.style.display = isCloudRealtime ? 'none' : '';

        // Wizard: TTS availability shows on the home card (disabled + reason) —
        // never hidden. If the user is inside the TTS detail when switching to a
        // cloud-realtime engine, snap back to home so the state change is visible.
        this._updateSettingsCards();
        if (isCloudRealtime && document.getElementById('tab-tts')?.classList.contains('active')) {
            this._showSettingsScreen('settings-home');
        }
        const btnOpenAiAudio = document.getElementById('btn-openai-audio');
        if (btnOpenAiAudio) btnOpenAiAudio.style.display = 'none';

        // Restrict target language list to 13 OpenAI-supported in openai mode.
        // Qwen LiveTranslate Flash has its own 60-language list (mirrors mobile
        // v0.4.3); Qwen also hides Auto on the source picker because the model
        // rejects "auto" on real mic input.
        this._refreshTargetLangList(mode);
        this._refreshSourceLangList(mode);
    },


    _updateLlmProviderUI() {
        const mode = migrateTranslationMode(document.getElementById('select-translation-mode')?.value);
        const llm = migrateLlmProvider(document.getElementById('select-llm-provider')?.value);
        const isLocal = mode === 'local';
        const isAutomatic = llm === 'automatic';
        const sectionLlm = document.getElementById('section-llm-provider');
        const sectionOr = document.getElementById('section-openrouter-key');
        const labelFallback = document.getElementById('label-llm-fallback');
        const hintFallback = document.getElementById('hint-llm-fallback');
        const hintAuto = document.getElementById('hint-llm-automatic');
        if (sectionLlm) sectionLlm.style.display = isLocal ? 'none' : '';
        if (sectionOr) sectionOr.style.display = 'none';
        if (labelFallback) labelFallback.style.display = (!isLocal && !isAutomatic) ? '' : 'none';
        if (hintFallback) hintFallback.style.display = (!isLocal && !isAutomatic) ? '' : 'none';
        if (hintAuto) hintAuto.style.display = (!isLocal && isAutomatic) ? '' : 'none';
        const groqLlm = document.getElementById('select-groq-llm-model');
        const cfLlm = document.getElementById('select-cloudflare-llm-model');
        if (groqLlm) groqLlm.style.display = '';
        if (cfLlm) cfLlm.style.display = '';
        this._updateChainUI();
    },


    _refreshTargetLangList(mode) {
        const select = document.getElementById('select-target-lang');
        if (!select) return;
        const current = select.value;
        if (this._fullTargetLangHTML) {
            select.innerHTML = this._fullTargetLangHTML;
            select.value = current || 'vi';
        }
    },


    _refreshSourceLangList(_mode) {
        const select = document.getElementById('select-source-lang');
        if (!select) return;
        const current = select.value;
        if (this._fullSourceLangHTML) {
            select.innerHTML = this._fullSourceLangHTML;
            select.value = current || 'auto';
        }
    },


    // ─── API key validation & connection test ─────────────

    // Inline format check — runs on every keystroke. Cheap, no network.
    // Updates: per-field status badge + engine dropdown option enable/disable.
    _refreshKeyStatus() {
        const aaiKey = document.getElementById('input-assemblyai-key')?.value.trim() || '';
        const aaiOk = aaiKey.length >= 20;
        const groqKey = document.getElementById('input-groq-key')?.value.trim() || '';
        const cfAccount = document.getElementById('input-cloudflare-account-id')?.value.trim() || '';
        const cfToken = document.getElementById('input-cloudflare-token')?.value.trim() || '';
        const groqOk = groqKey.length >= 20;
        const cfOk = cfAccount.length >= 8 && cfToken.length >= 20;
        const orKey = document.getElementById('input-openrouter-key')?.value.trim() || '';
        const orOk = orKey.startsWith('sk-or-') || orKey.length >= 20;

        const aaiStatus = document.getElementById('key-status-assemblyai');
        if (aaiStatus) {
            aaiStatus.className = 'key-status ' + (aaiKey === '' ? '' : aaiOk ? 'ok' : 'bad');
            aaiStatus.textContent = aaiKey === '' ? '' : aaiOk ? '✓ format ok' : '✗ check format';
        }
        const groqStatus = document.getElementById('key-status-groq');
        if (groqStatus) {
            groqStatus.className = 'key-status ' + (groqKey === '' ? '' : groqOk ? 'ok' : 'bad');
            groqStatus.textContent = groqKey === '' ? '' : groqOk ? '✓ format ok' : '✗ check format';
        }
        const cfStatus = document.getElementById('key-status-cloudflare');
        if (cfStatus) {
            const empty = !cfAccount && !cfToken;
            cfStatus.className = 'key-status ' + (empty ? '' : cfOk ? 'ok' : 'bad');
            cfStatus.textContent = empty ? '' : cfOk ? '✓ format ok' : '✗ account + token required';
        }
        const orStatus = document.getElementById('key-status-openrouter');
        if (orStatus) {
            orStatus.className = 'key-status ' + (orKey === '' ? '' : orOk ? 'ok' : 'bad');
            orStatus.textContent = orKey === '' ? '' : orOk ? '✓ format ok' : '✗ check format';
        }

        const select = document.getElementById('select-translation-mode');
        if (select) {
            const groqOpt = select.querySelector('option[value="groq"]');
            const cfOpt = select.querySelector('option[value="cloudflare"]');
            if (groqOpt) groqOpt.textContent = groqOk ? '⚡ Groq — Fast (Primary)' : '⚡ Groq — API key required';
            if (cfOpt) cfOpt.textContent = cfOk ? '☁️ Cloudflare — Fallback' : '☁️ Cloudflare — credentials required';
        }
    },


    // Live ping the provider to verify key actually works.
    async _testConnection(provider) {
        const statusEl = document.getElementById(`key-status-${provider}`);
        const btn = document.getElementById(`btn-test-${provider}`);
        if (!statusEl || !btn) return;

        btn.disabled = true;
        statusEl.className = 'key-status checking';
        statusEl.textContent = '… testing';

        try {
            let ok = false;
            if (provider === 'assemblyai') {
                const apiKey = document.getElementById('input-assemblyai-key')?.value.trim() || '';
                if (!apiKey) throw new Error('empty');
                ok = await invoke('assemblyai_ping', { apiKey, region: 'global' });
            } else if (provider === 'groq') {
                const apiKey = document.getElementById('input-groq-key')?.value.trim() || '';
                if (!apiKey) throw new Error('empty');
                ok = await invoke('groq_ping', { apiKey });
            } else if (provider === 'cloudflare') {
                const accountId = document.getElementById('input-cloudflare-account-id')?.value.trim() || '';
                const apiToken = document.getElementById('input-cloudflare-token')?.value.trim() || '';
                if (!accountId || !apiToken) throw new Error('empty');
                ok = await invoke('cloudflare_ping', { accountId, apiToken });
            } else if (provider === 'openrouter') {
                const apiKey = document.getElementById('input-openrouter-key')?.value.trim() || '';
                if (!apiKey) throw new Error('empty');
                ok = await invoke('openrouter_ping', { apiKey });
            } else if (provider === 'azure') {
                const subscriptionKey = document.getElementById('input-azure-key')?.value.trim() || '';
                const region = document.getElementById('input-azure-region')?.value.trim() || '';
                const endpoint = document.getElementById('input-azure-endpoint')?.value.trim()
                    || 'https://api.cognitive.microsofttranslator.com';
                if (!subscriptionKey) throw new Error('empty');
                // Use Rust backend — browser fetch hits CORS in Tauri webview
                ok = await invoke('azure_translator_ping', { subscriptionKey, region, endpoint });
            } else if (provider === 'gemini') {
                const apiKey = document.getElementById('input-gemini-key')?.value.trim() || '';
                const model = document.getElementById('select-gemini-model')?.value || 'gemini-3.1-flash-lite';
                if (!apiKey) throw new Error('empty');
                // Use Rust backend — browser fetch hits CORS in Tauri webview
                ok = await invoke('gemini_ping', { apiKey, model });
            } else if (provider === 'ollama') {
                const baseUrl = document.getElementById('input-ollama-url')?.value.trim() || 'http://127.0.0.1:11434';
                const modelName = document.getElementById('input-ollama-model')?.value.trim() || '';
                if (!ollamaTranslator.isLoopbackUrl(baseUrl)) {
                    throw new Error('loopback only');
                }
                const health = await invoke('ollama_health_check', { baseUrl });
                const models = (health?.models || []).map((m) => m.name || m.model).filter(Boolean);
                if (modelName && models.length && !models.includes(modelName)) {
                    throw new Error(`model '${modelName}' not found`);
                }
                ok = true;
            }
            statusEl.className = 'key-status ' + (ok ? 'ok' : 'bad');
            statusEl.textContent = ok ? '✓ connected' : '✗ rejected';
        } catch (e) {
            statusEl.className = 'key-status bad';
            const msg = String(e?.message || e || 'failed')
                .replace(/^Gemini:\s*/i, '')
                .replace(/^Azure Translator:\s*/i, '');
            statusEl.textContent = '✗ ' + (msg.length > 48 ? msg.slice(0, 45) + '…' : msg);
            statusEl.title = msg;
        } finally {
            btn.disabled = false;
        }
    },


    _updateChainUI() {
        const settings = settingsManager.get();
        // Override settings with in-memory form values if present
        const formSettings = {
            ...settings,
            openrouter_api_key: document.getElementById('input-openrouter-key')?.value.trim() || settings.openrouter_api_key,
            groq_api_key: document.getElementById('input-groq-key')?.value.trim() || settings.groq_api_key,
            groq_enabled: true,
            cloudflare_account_id: document.getElementById('input-cloudflare-account-id')?.value.trim() || settings.cloudflare_account_id,
            cloudflare_api_token: document.getElementById('input-cloudflare-token')?.value.trim() || settings.cloudflare_api_token,
            cloudflare_enabled: true,
            assemblyai_api_key: document.getElementById('input-assemblyai-key')?.value.trim() || settings.assemblyai_api_key,
            assemblyai_enabled: document.getElementById('check-assemblyai-enabled')?.checked ?? settings.assemblyai_enabled,
            azure_translator_enabled: document.getElementById('check-azure-enabled')?.checked ?? settings.azure_translator_enabled,
            azure_translator_key: document.getElementById('input-azure-key')?.value.trim() || settings.azure_translator_key,
            gemini_enabled: document.getElementById('check-gemini-enabled')?.checked ?? settings.gemini_enabled,
            gemini_api_key: document.getElementById('input-gemini-key')?.value.trim() || settings.gemini_api_key,
            ollama_enabled: document.getElementById('check-ollama-enabled')?.checked ?? settings.ollama_enabled,
            ollama_model: document.getElementById('input-ollama-model')?.value.trim() || settings.ollama_model,
            llm_provider: migrateLlmProvider(document.getElementById('select-llm-provider')?.value || settings.llm_provider),
            llm_fallback: document.getElementById('check-llm-fallback')?.checked ?? settings.llm_fallback,
        };

        const platform = this._platformContext();
        const sttChain = getEffectiveSTTChain(formSettings, platform);
        const transChain = getEffectiveTranslationChain(formSettings, this.activeSttProvider || this.translationMode);

        const sttEl = document.getElementById('chain-stt-display');
        if (sttEl) {
            sttEl.textContent = sttChain.length > 0 ? sttChain.join(' → ') : 'None configured';
        }
        const transEl = document.getElementById('chain-translation-display');
        if (transEl) {
            transEl.textContent = transChain.length > 0 ? transChain.join(' → ') : 'None configured';
        }
        const runtimeEl = document.getElementById('chain-runtime-stt');
        if (runtimeEl) {
            const primary = formSettings.translation_mode || settings.translation_mode || 'automatic';
            const active = this.activeSttProvider || '—';
            runtimeEl.textContent = `primary ${primary} · active ${active}`;
        }
        const breakerEl = document.getElementById('circuit-breaker-status-text');
        if (breakerEl) {
            const blocked = getCircuitBreakerStatuses().filter((s) => s.state !== 'closed');
            if (!blocked.length) {
                breakerEl.textContent = 'Circuit breakers: Normal';
            } else {
                breakerEl.textContent = blocked.map((s) => {
                    const secs = s.remainingMs == null ? 'until reset' : `${Math.ceil(s.remainingMs / 1000)}s`;
                    return `${s.key} (${secs})`;
                }).join(' · ');
            }
        }
    },


    _platformContext() {
        return {
            os: this._platformOs,
            isAppleSilicon: !!this.isAppleSilicon,
        };
    }

};
