/**
 * App TTS controls, Microsoft/local voice managers, and glossary row helpers.
 * Mixed onto App.prototype from app.js.
 */

import { settingsManager } from './settings.js';
import { elevenLabsTTS } from './elevenlabs-tts.js';
import { googleTTS } from './google-tts.js';
import { edgeTTSRust } from './edge-tts.js';
import { microsoftTTS } from './microsoft-tts.js';
import { googleFreeTTS } from './google-free-tts.js';
import { tiktokTTS } from './tiktok-tts.js';
import { localTTS } from './local-tts.js';
import { audioPlayer } from './audio-player.js';

const { invoke, Channel } = window.__TAURI__.core;

// Static fallback for Microsoft v2 voices when the live list endpoint is unreachable.
const MS_LANG_LABELS = {
    vi: 'Vietnamese',
    en: 'English',
    ro: 'Romanian',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
    it: 'Italian',
    pt: 'Portuguese',
    pl: 'Polish',
    nl: 'Dutch',
    tr: 'Turkish',
    ru: 'Russian',
    ja: 'Japanese',
    ko: 'Korean',
    zh: 'Chinese',
    ar: 'Arabic',
    th: 'Thai',
    id: 'Indonesian',
    uk: 'Ukrainian',
    hi: 'Hindi',
    sv: 'Swedish',
    da: 'Danish',
    fi: 'Finnish',
    nb: 'Norwegian',
    cs: 'Czech',
    el: 'Greek',
    he: 'Hebrew',
    hu: 'Hungarian',
    ms: 'Malay',
};

const MS_VOICE_FALLBACK = [
    { short_name: 'vi-VN-HoaiMyNeural', friendly_name: 'HoaiMy', gender: 'Female', locale: 'vi-VN' },
    { short_name: 'vi-VN-NamMinhNeural', friendly_name: 'NamMinh', gender: 'Male', locale: 'vi-VN' },
    { short_name: 'en-US-JennyNeural', friendly_name: 'Jenny', gender: 'Female', locale: 'en-US' },
    { short_name: 'en-US-GuyNeural', friendly_name: 'Guy', gender: 'Male', locale: 'en-US' },
    { short_name: 'ro-RO-AlinaNeural', friendly_name: 'Alina', gender: 'Female', locale: 'ro-RO' },
    { short_name: 'ro-RO-EmilNeural', friendly_name: 'Emil', gender: 'Male', locale: 'ro-RO' },
    { short_name: 'fr-FR-DeniseNeural', friendly_name: 'Denise', gender: 'Female', locale: 'fr-FR' },
    { short_name: 'de-DE-KatjaNeural', friendly_name: 'Katja', gender: 'Female', locale: 'de-DE' },
    { short_name: 'es-ES-ElviraNeural', friendly_name: 'Elvira', gender: 'Female', locale: 'es-ES' },
    { short_name: 'ja-JP-NanamiNeural', friendly_name: 'Nanami', gender: 'Female', locale: 'ja-JP' },
    { short_name: 'ko-KR-SunHiNeural', friendly_name: 'SunHi', gender: 'Female', locale: 'ko-KR' },
    { short_name: 'zh-CN-XiaoxiaoNeural', friendly_name: 'Xiaoxiao', gender: 'Female', locale: 'zh-CN' },
];

export const appTtsMethods = {


    _bindTtsControls() {
        this._on('btn-tts', 'click', () => {
            this._toggleTTS();
        });
    },


    // ─── TTS Control ──────────────────────────────────────

    async _toggleTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';

        // Block TTS in two-way mode to prevent audio feedback loop
        const translationType = document.getElementById('select-translation-type')?.value;
        if (translationType === 'two_way') {
            this._showToast('TTS is disabled in two-way mode to prevent audio loop', 'error');
            return;
        }

        // Local provider: the selected voice must actually be downloaded (async check).
        // Only gate when turning ON (turning off never needs a model).
        if (provider === 'local' && !this.ttsEnabled) {
            const installed = await this._isLocalVoiceInstalled(settings.local_tts_voice);
            if (!installed) {
                this._showToast('Download a voice in Settings → TTS → Local', 'error');
                this._showView('settings');
                return;
            }
        }

        // Check credentials for providers that require them (free providers need none)
        if (provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('Add ElevenLabs API key in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            this._showToast('Add Google TTS API key in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }
        if (provider === 'tiktok' && !settings.tiktok_session_id) {
            this._showToast('Add a TikTok sessionid in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }

        this.ttsEnabled = !this.ttsEnabled;
        this._updateTTSButton();

        const tts = this._getActiveTTS();

        if (this.ttsEnabled) {
            this._configureTTS(tts, settings);
            if (this.isRunning) {
                tts.connect();
                audioPlayer.resume();
            }
            const label = {
                edge: 'Edge TTS (Free)',
                microsoft: 'Microsoft v2 (Free)',
                'google-free': 'Google TTS (Free)',
                tiktok: 'TikTok TTS (Free)',
                local: 'Local Offline',
                google: 'Google Chirp 3 HD',
                elevenlabs: 'ElevenLabs',
            }[provider] || provider;
            this._showToast(`TTS narration ON 🔊 (${label})`, 'success');
        } else {
            tts.disconnect();
            audioPlayer.stop();
            this._showToast('TTS narration OFF 🔇', 'success');
        }
    },


    _getActiveTTS() {
        const provider = settingsManager.get().tts_provider || 'edge';
        const map = {
            edge: edgeTTSRust,
            microsoft: microsoftTTS,
            'google-free': googleFreeTTS,
            tiktok: tiktokTTS,
            local: localTTS,
            google: googleTTS,
            elevenlabs: elevenLabsTTS,
        };
        const tts = map[provider];
        if (!tts) {
            console.warn(`[TTS] Unknown provider "${provider}", falling back to Edge`);
            return edgeTTSRust;
        }
        return tts;
    },


    _configureTTS(tts, settings) {
        const provider = settings.tts_provider || 'edge';
        // Client-side playback speed ONLY for providers whose endpoint has no rate param
        // (Google-free, TikTok). Others apply speed server-side / in the engine → keep 1.0.
        const clientRate =
            provider === 'google-free' ? (settings.google_free_speed || 1.0) :
            provider === 'tiktok' ? (settings.tiktok_speed || 1.0) : 1.0;
        audioPlayer.setPlaybackRate(clientRate);
        if (provider === 'elevenlabs') {
            tts.configure({
                apiKey: settings.elevenlabs_api_key,
                voiceId: settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            });
        } else if (provider === 'google') {
            const voice = settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            const langCode = voice.replace(/-Chirp3.*/, '');
            tts.configure({
                apiKey: settings.google_tts_api_key,
                voice: voice,
                languageCode: langCode,
                speakingRate: settings.google_tts_speed || 1.0,
            });
        } else if (provider === 'microsoft') {
            tts.configure({
                voice: settings.microsoft_v2_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.microsoft_v2_speed !== undefined ? settings.microsoft_v2_speed : 20,
            });
        } else if (provider === 'google-free') {
            tts.configure({
                voice: settings.google_free_voice || 'vi-VN',
                apiKey: settings.google_free_api_key || '',
            });
        } else if (provider === 'tiktok') {
            tts.configure({
                voice: settings.tiktok_voice || 'BV074_streaming',
                sessionId: settings.tiktok_session_id || '',
            });
        } else if (provider === 'local') {
            tts.configure({
                voice: settings.local_tts_voice || 'vi_VN-vais1000-medium',
                speed: settings.local_tts_speed || 1.0,
            });
        } else {
            tts.configure({
                voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20,
            });
        }
    },


    _addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'term-row';
        row.innerHTML = `<input type="text" class="term-source" value="${source}" placeholder="Source" />` +
            `<input type="text" class="term-target" value="${target}" placeholder="Target" />` +
            `<button type="button" class="btn-remove-term" title="Remove">×</button>`;
        row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
        list.appendChild(row);
    },


    _addGeneralRow(key = '', value = '') {
        const list = document.getElementById('context-general-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'general-row';
        row.innerHTML = `<input type="text" class="general-key" value="${this._escAttr(key)}" placeholder="Key (e.g. domain)" />` +
            `<input type="text" class="general-value" value="${this._escAttr(value)}" placeholder="Value (e.g. Medical)" />` +
            `<button type="button" class="btn-remove-general" title="Remove">×</button>`;
        row.querySelector('.btn-remove-general').addEventListener('click', () => row.remove());
        list.appendChild(row);
    },


    _escAttr(str) {
        return String(str ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },


    _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },


    _updateTTSProviderUI(provider) {
        // Show only the active provider's settings panel.
        const panels = {
            edge: 'tts-edge-settings',
            microsoft: 'tts-microsoft-settings',
            'google-free': 'tts-google-free-settings',
            tiktok: 'tts-tiktok-settings',
            local: 'tts-local-settings',
            google: 'tts-google-settings',
            elevenlabs: 'tts-elevenlabs-settings',
        };
        for (const [id, elId] of Object.entries(panels)) {
            const el = document.getElementById(elId);
            if (el) el.style.display = provider === id ? '' : 'none';
        }
        // Update hint text
        const hint = document.getElementById('tts-provider-hint');
        if (hint) {
            const hints = {
                edge: 'Free, natural voices — no API key needed',
                microsoft: 'Free — full Microsoft Neural voice list (all languages), sent to Microsoft',
                'google-free': 'Free — experimental, may stop working anytime. Text sent to Google',
                tiktok: 'Free — needs a TikTok sessionid. Text sent to TikTok',
                local: 'Free & 100% offline — download a voice below; nothing is sent anywhere',
                google: 'Near-human quality — requires Google Cloud API key (1M chars/month free)',
                elevenlabs: 'Premium quality — requires ElevenLabs API key',
            };
            hint.textContent = hints[provider] || '';
        }
        // Microsoft v2: populate the full voice list dynamically (fallback stays in HTML).
        if (provider === 'microsoft') this._populateMicrosoftVoices();
        // Local: fetch catalog + install state and render the downloadable voice list.
        if (provider === 'local') this._populateLocalVoices();
    },


    /**
     * Fetch Microsoft's Neural voice list once (cached), rebuild Language options
     * from all locales, then fill the voice dropdown for the selected language.
     */
    async _populateMicrosoftVoices() {
        const langSel = document.getElementById('select-microsoft-lang');
        const saved = settingsManager.get().microsoft_v2_voice || 'vi-VN-HoaiMyNeural';
        if (!this._msVoices) {
            try {
                const voices = await microsoftTTS.listVoices();
                this._msVoices = (Array.isArray(voices) && voices.length) ? voices : MS_VOICE_FALLBACK;
            } catch (err) {
                console.warn('[Microsoft v2] voice list fetch failed, using static fallback:', err);
                this._msVoices = MS_VOICE_FALLBACK;
            }
        }
        this._rebuildMicrosoftLangOptions(saved);
        this._fillMicrosoftVoices(langSel ? langSel.value : 'vi');
    },


    /** Rebuild Language dropdown from unique locale prefixes in the voice cache. */
    _rebuildMicrosoftLangOptions(savedVoice) {
        const langSel = document.getElementById('select-microsoft-lang');
        if (!langSel) return;
        const voices = this._msVoices || MS_VOICE_FALLBACK;
        const prefixes = [...new Set(
            voices
                .map(v => (v.locale || '').split('-')[0].toLowerCase())
                .filter(Boolean)
        )].sort((a, b) => {
            const la = MS_LANG_LABELS[a] || a;
            const lb = MS_LANG_LABELS[b] || b;
            return la.localeCompare(lb);
        });
        const prev = langSel.value;
        langSel.innerHTML = '';
        for (const p of prefixes) {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = MS_LANG_LABELS[p] || p.toUpperCase();
            langSel.appendChild(opt);
        }
        const fromSaved = (savedVoice || '').match(/^([a-z]{2,3})/i)?.[1]?.toLowerCase();
        if (fromSaved && prefixes.includes(fromSaved)) langSel.value = fromSaved;
        else if (prev && prefixes.includes(prev)) langSel.value = prev;
        else if (prefixes.includes('en')) langSel.value = 'en';
        else if (prefixes.length) langSel.value = prefixes[0];
    },


    /** Fill #select-microsoft-voice with cached voices for `lang` prefix, restoring saved. */
    _fillMicrosoftVoices(lang) {
        const select = document.getElementById('select-microsoft-voice');
        if (!select) return;
        const saved = settingsManager.get().microsoft_v2_voice;
        const prefix = (lang || 'vi').toLowerCase();
        const list = (this._msVoices || MS_VOICE_FALLBACK).filter(v =>
            (v.locale || '').toLowerCase().startsWith(prefix)
        );
        select.innerHTML = '';
        for (const v of list) {
            const opt = document.createElement('option');
            opt.value = v.short_name;
            opt.textContent = `${v.friendly_name} (${v.gender})`;
            select.appendChild(opt);
        }
        // Keep the saved voice if it belongs to this language, else pick the first.
        if (saved && list.some(v => v.short_name === saved)) select.value = saved;
        else if (select.options.length) select.selectedIndex = 0;
    },


    // ─── Local offline (Piper) voice manager ──────────────

    /** Fetch the catalog + install state once per open, then render the list. */
    async _populateLocalVoices() {
        const langSel = document.getElementById('select-local-lang');
        const saved = settingsManager.get().local_tts_voice || 'vi_VN-vais1000-medium';
        // Show the real resolved models folder (per-OS absolute path) so the user can
        // find the files themselves. Falls back to the raw setting if the query fails.
        const dirInput = document.getElementById('input-local-models-dir');
        if (dirInput) {
            try {
                dirInput.value = await invoke('local_tts_models_dir_path');
            } catch {
                dirInput.value = settingsManager.get().local_tts_models_dir || 'Default app location';
            }
        }
        // Speed slider from saved setting.
        const speedSlider = document.getElementById('range-local-speed');
        const speedLabel = document.getElementById('local-speed-value');
        const speed = settingsManager.get().local_tts_speed || 1.0;
        if (speedSlider) speedSlider.value = speed;
        if (speedLabel) speedLabel.textContent = parseFloat(speed).toFixed(1) + 'x';
        await this._refreshLocalVoices();
        this._rebuildLocalLangOptions(saved);
        this._fillLocalVoices(langSel ? langSel.value : 'vi');
    },


    /** Rebuild Language dropdown from unique langs in the local catalog. */
    _rebuildLocalLangOptions(savedVoice) {
        const langSel = document.getElementById('select-local-lang');
        if (!langSel) return;
        const labels = {
            vi: 'Vietnamese', en: 'English', ro: 'Romanian', fr: 'French', de: 'German',
            es: 'Spanish', it: 'Italian', pt: 'Portuguese', pl: 'Polish', nl: 'Dutch',
            cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', el: 'Greek', sv: 'Swedish',
            da: 'Danish', ru: 'Russian', uk: 'Ukrainian', tr: 'Turkish', zh: 'Chinese',
            ar: 'Arabic', hi: 'Hindi', id: 'Indonesian',
        };
        const langs = [...new Set(
            (this._localVoices || []).filter(v => !v.imported && v.lang).map(v => v.lang)
        )].sort((a, b) => (labels[a] || a).localeCompare(labels[b] || b));
        if (!langs.length) return;
        const prev = langSel.value;
        langSel.innerHTML = '';
        for (const code of langs) {
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = labels[code] || code.toUpperCase();
            langSel.appendChild(opt);
        }
        const fromSaved = this._localLangFromVoiceId(savedVoice);
        if (fromSaved && langs.includes(fromSaved)) langSel.value = fromSaved;
        else if (prev && langs.includes(prev)) langSel.value = prev;
        else if (langs.includes('en')) langSel.value = 'en';
        else langSel.value = langs[0];
    },


    _localLangFromVoiceId(id) {
        if (!id) return 'vi';
        const hit = (this._localVoices || []).find(v => v.id === id);
        if (hit?.lang) return hit.lang;
        if (id === 'adam1' || id === 'minhquang') return 'vi';
        const m = id.match(/^([a-z]{2})_/i);
        return m ? m[1].toLowerCase() : 'vi';
    },


    /** (Re)load the catalog + install state from the backend into a cache. */
    async _refreshLocalVoices() {
        try {
            const list = await invoke('local_tts_list_models');
            this._localVoices = Array.isArray(list) ? list : [];
        } catch (err) {
            console.warn('[Local TTS] list failed:', err);
            this._localVoices = [];
        }
        this._localInstalled = new Set(
            (this._localVoices || []).filter(v => v.installed).map(v => v.id)
        );
    },


    /** True if `id` is currently installed (fresh backend check). */
    async _isLocalVoiceInstalled(id) {
        if (!id) return false;
        await this._refreshLocalVoices();
        return this._localInstalled.has(id);
    },


    /** Render the voice rows for `lang` ("vi"|"en") with download/delete controls. */
    _fillLocalVoices(lang) {
        const container = document.getElementById('local-voice-list');
        if (!container) return;
        const saved = settingsManager.get().local_tts_voice;
        const all = this._localVoices || [];
        // Catalog voices filter by the selected language; imported (local) voices are shown
        // regardless of language (their language is unknown).
        const catalogList = all.filter(v => !v.imported && v.lang === lang);
        const importedList = all.filter(v => v.imported);
        container.innerHTML = '';
        if (!catalogList.length && !importedList.length) {
            container.innerHTML = '<p class="hint">No voices for this language.</p>';
            return;
        }

        const addRow = (v) => {
            const row = document.createElement('div');
            row.className = 'local-voice-row';
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;';
            const sizeMb = (v.approxSizeBytes / 1e6).toFixed(0);
            if (v.installed) {
                const checked = saved === v.id ? 'checked' : '';
                row.innerHTML =
                    `<label style="flex:1;display:flex;align-items:center;gap:6px;cursor:pointer;">` +
                    `<input type="radio" name="local-voice" value="${v.id}" ${checked} />` +
                    `<span>${this._esc(v.display)}</span></label>` +
                    `<button type="button" class="icon-btn small btn-local-delete" data-id="${v.id}" title="Delete">🗑️</button>`;
            } else {
                row.innerHTML =
                    `<span style="flex:1;color:var(--text-muted,#888);">${this._esc(v.display)} · ${sizeMb} MB</span>` +
                    `<span class="local-progress" data-id="${v.id}" style="min-width:64px;text-align:right;"></span>` +
                    `<button type="button" class="icon-btn small btn-local-download" data-id="${v.id}" title="Download">⬇️</button>`;
            }
            container.appendChild(row);
        };

        catalogList.forEach(addRow);
        if (importedList.length) {
            const hdr = document.createElement('p');
            hdr.className = 'hint';
            hdr.style.cssText = 'margin:8px 0 2px;font-weight:600;';
            hdr.textContent = `Imported (local) — ${importedList.length}`;
            container.appendChild(hdr);
            importedList.forEach(addRow);
        }

        container.querySelectorAll('.btn-local-download').forEach(btn =>
            btn.addEventListener('click', () => this._downloadLocalVoice(btn.dataset.id))
        );
        container.querySelectorAll('.btn-local-delete').forEach(btn =>
            btn.addEventListener('click', () => this._deleteLocalVoice(btn.dataset.id))
        );
        container.querySelectorAll('input[name="local-voice"]').forEach(radio =>
            radio.addEventListener('change', () => {
                if (radio.checked) settingsManager.save({ local_tts_voice: radio.value });
            })
        );
    },


    /** Download a voice model with live progress, then re-render as installed. */
    async _downloadLocalVoice(id) {
        // Download straight into the default app models folder — no folder prompt.
        // Users who want a custom location can still set it via the Model folder field.
        const progressEl = document.querySelector(`.local-progress[data-id="${id}"]`);
        const btn = document.querySelector(`.btn-local-download[data-id="${id}"]`);
        if (btn) btn.disabled = true;
        const onProgress = new Channel();
        onProgress.onmessage = (msg) => {
            if (!progressEl) return;
            if (msg.phase === 'downloading' && msg.total > 0) {
                progressEl.textContent = `${Math.floor((msg.received / msg.total) * 100)}%`;
            } else if (msg.phase === 'extracting') {
                progressEl.textContent = '…';
            }
        };
        try {
            await invoke('local_tts_download_model', { id, onProgress });
            this._showToast('Voice downloaded ✓', 'success');
            await this._refreshLocalVoices();
            this._fillLocalVoices(document.getElementById('select-local-lang')?.value || 'vi');
        } catch (err) {
            this._showToast(`Download failed: ${err}`, 'error');
            if (btn) btn.disabled = false;
            if (progressEl) progressEl.textContent = '';
        }
    },


    /** Delete an installed voice (real on-device removal), then re-render. */
    async _deleteLocalVoice(id) {
        try {
            await invoke('local_tts_delete_model', { id });
            this._showToast('Voice deleted', 'success');
            await this._refreshLocalVoices();
            this._fillLocalVoices(document.getElementById('select-local-lang')?.value || 'vi');
        } catch (err) {
            this._showToast(`Delete failed: ${err}`, 'error');
        }
    },


    /**
     * Open the folder picker; on pick, persist as models dir and refresh.
     * Returns the chosen path, or null if the user cancelled (so callers can abort),
     * or '' if the picker itself failed.
     */
    async _maybePickModelsDir() {
        try {
            const { open } = window.__TAURI__.dialog;
            const picked = await open({ directory: true, multiple: false, title: 'Choose model folder' });
            if (picked === null || picked === undefined) return null; // cancelled
            const dir = Array.isArray(picked) ? picked[0] : picked;
            await settingsManager.save({ local_tts_models_dir: dir });
            const dirInput = document.getElementById('input-local-models-dir');
            if (dirInput) dirInput.value = dir;
            await this._refreshLocalVoices();
            this._fillLocalVoices(document.getElementById('select-local-lang')?.value || 'vi');
            return dir;
        } catch (err) {
            console.warn('[Local TTS] folder pick failed:', err);
            return '';
        }
    },


    /** Reset the model folder back to the default app location and refresh the list. */
    async _resetModelsDir() {
        await settingsManager.save({ local_tts_models_dir: '' });
        const dirInput = document.getElementById('input-local-models-dir');
        if (dirInput) {
            try {
                dirInput.value = await invoke('local_tts_models_dir_path');
            } catch {
                dirInput.value = 'Default app location';
            }
        }
        await this._refreshLocalVoices();
        this._fillLocalVoices(document.getElementById('select-local-lang')?.value || 'vi');
        this._showToast('Model folder reset to default', 'success');
    },


    _updateTranslationTypeUI(type) {
        const oneway = document.getElementById('section-oneway-langs');
        const twoway = document.getElementById('section-twoway-langs');
        const hintTwoway = document.getElementById('hint-twoway');
        const strictLang = document.getElementById('section-strict-lang');

        if (type === 'two_way') {
            if (oneway) oneway.style.display = 'none';
            if (twoway) twoway.style.display = 'flex';
            if (hintTwoway) hintTwoway.style.display = 'block';
            // Hide strict lang in two-way mode (both languages are specified)
            if (strictLang) strictLang.style.display = 'none';
            // Force-disable TTS in two-way mode to prevent audio feedback loop
            if (this.ttsEnabled) {
                this.ttsEnabled = false;
                this._getActiveTTS().disconnect();
                audioPlayer.stop();
            }
            this._updateTTSButton();
        } else {
            if (oneway) oneway.style.display = 'flex';
            if (twoway) twoway.style.display = 'none';
            if (hintTwoway) hintTwoway.style.display = 'none';
            if (strictLang) strictLang.style.display = 'flex';
            this._updateTTSButton();
        }
    },


    _updateTTSButton() {
        const btn = document.getElementById('btn-tts');
        const iconOff = document.getElementById('icon-tts-off');
        const iconOn = document.getElementById('icon-tts-on');
        const isTwoWay = document.getElementById('select-translation-type')?.value === 'two_way';

        if (btn) {
            btn.classList.toggle('active', this.ttsEnabled);
            btn.classList.toggle('disabled', isTwoWay);
            btn.title = isTwoWay ? 'TTS disabled in two-way mode' : 'Toggle TTS (Ctrl+T)';
        }
        if (iconOff) iconOff.style.display = this.ttsEnabled ? 'none' : 'block';
        if (iconOn) iconOn.style.display = this.ttsEnabled ? 'block' : 'none';
    },


    _speakIfEnabled(text) {
        if (this.ttsEnabled && text?.trim()) {
            this._getActiveTTS().speak(text);
        }
    }

};
