/**
 * App in-overlay Read mode (paste text → TTS).
 * Mixed onto App.prototype from app.js.
 */

import { settingsManager } from './settings.js';
import { readAudioPlayer } from './audio-player.js';
import { Reader } from './reader.js';
import {
    initShell,
    getActivity,
    bindMenu,
    isAutoHideEnabled,
    setAutoHideEnabled,
} from './ui-shell.js';

// Conservative per-provider chunk caps (chars). Local is offline (no endpoint cap);
// cloud providers use safe values; google-free/tiktok stay well under their real caps
// (TikTok's Rust command hard-caps at 280). Raise only after measuring a live call.
const READ_MAX_LEN = { local: 400, edge: 200, microsoft: 200, google: 200, 'google-free': 120, tiktok: 120 };

export const appReadMethods = {
    // ─── Read Mode (in-overlay TTS reader) ─────────────────

    _initReadMode() {
        // Activity shell: switcher clicks → panels; side effects handled here.
        initShell();
        document.addEventListener('activity-changed', (e) => this._onActivityChanged(e.detail));
        // Overflow menu (⋯) in the Live action row
        this._moreMenu = bindMenu('btn-more', 'more-menu');
        // Close after navigate/destructive/layout actions (split stays reopenable
        // via ⋯ — dual-view no longer clips the action row).
        ['btn-copy', 'btn-clear', 'btn-compact', 'btn-view-mode', 'btn-shortcuts'].forEach((id) => {
            document.getElementById(id)?.addEventListener('click', () => this._moreMenu.close());
        });
        // Shortcut sheet (⋯ menu + `?` key; Esc/click-outside closes)
        const sheet = document.getElementById('shortcut-sheet');
        const toggleSheet = (show) => { if (sheet) sheet.style.display = show ? '' : 'none'; };
        document.getElementById('btn-shortcuts')?.addEventListener('click', () => toggleSheet(true));
        sheet?.addEventListener('click', (e) => { if (e.target === sheet) toggleSheet(false); });
        this._toggleShortcutSheet = toggleSheet;

        // Read quick-pick: save the active provider's voice key + re-check capability
        document.getElementById('read-voice-quick')?.addEventListener('change', (e) => {
            const key = e.target.dataset.key;
            if (!key) return;
            settingsManager.save({ [key]: e.target.value });
            this._showReadCapabilityHint();
        });
        // "More settings…" deep-links to Settings → TTS detail
        document.getElementById('btn-read-tts-settings')?.addEventListener('click', () => {
            this._showView('settings');
            this._showSettingsScreen('tab-tts');
        });
        // Auto-hide toolbar toggle (✓ prefix reflects state; persists in localStorage)
        const autoHideBtn = document.getElementById('btn-auto-hide');
        const autoHideLabel = (autoHideBtn?.textContent || 'Auto-hide while translating')
            .replace(/^[✓　]\s*/, '')
            .trim();
        const renderAutoHide = () => {
            if (autoHideBtn) {
                autoHideBtn.textContent = `${isAutoHideEnabled() ? '✓' : '　'} ${autoHideLabel}`;
            }
        };
        renderAutoHide();
        autoHideBtn?.addEventListener('click', () => {
            setAutoHideEnabled(!isAutoHideEnabled());
            renderAutoHide();
        });
        document.getElementById('btn-read-play')?.addEventListener('click', () => {
            // Play doubles as Resume when paused — do NOT rebuild the reader.
            if (this._reader && this._reader.state === 'paused') this._reader.play();
            else this._startRead();
        });
        document.getElementById('btn-read-pause')?.addEventListener('click', () => {
            this._reader?.pause();
        });
        document.getElementById('btn-read-stop')?.addEventListener('click', () => this._stopRead());
    },


    /** Side effects when the activity switcher changes space. Panel visibility
     *  itself is owned by ui-shell; this handles pause/drain/render concerns. */
    _onActivityChanged({ activity, previous }) {
        if (previous === 'read' && activity !== 'read') this._exitReadMode();
        if (activity === 'read') this._enterReadMode();
        if (activity === 'library') this._showSessions();
    },


    async _enterReadMode() {
        // Stop any running Live session AND drain the shared provider's queue so an in-flight
        // Live synth cannot fire onAudioChunk into the Live context after the switch.
        // Panel visibility is owned by ui-shell; here we only hide the Live-only
        // toolbar controls (shared toolbar until the phase-2 consolidation).
        if (this.isRunning) await this.pause();
        try { this._getActiveTTS().disconnect(); } catch { /* provider may be idle */ }

        this._readMode = 'read'; // legacy alias for getActivity()==='read' checks
        // Live controls now live inside the Live panel, which ui-shell hides —
        // no per-element toggling needed anymore.
        this._resetReadUI();
        this._populateReadQuickPick();
        this._showReadCapabilityHint();
    },


    /**
     * Voice quick-pick in the Read panel — mirrors the active provider's voice
     * options from its Settings select (DRY: one source of options, two views).
     * Local voices come from the installed catalog instead.
     */
    async _populateReadQuickPick() {
        const sel = document.getElementById('read-voice-quick');
        if (!sel) return;
        const s = settingsManager.get();
        const provider = s.tts_provider || 'edge';
        const map = {
            edge: { src: 'select-edge-voice', key: 'edge_tts_voice' },
            microsoft: { src: 'select-microsoft-voice', key: 'microsoft_v2_voice' },
            'google-free': { src: 'select-google-free-voice', key: 'google_free_voice' },
            tiktok: { src: 'select-tiktok-voice', key: 'tiktok_voice' },
            google: { src: 'select-google-voice', key: 'google_tts_voice' },
            elevenlabs: { src: 'select-tts-voice', key: 'tts_voice_id' },
        };
        sel.innerHTML = '';
        if (provider === 'local') {
            await this._refreshLocalVoices();
            const installed = (this._localVoices || []).filter(v => v.installed);
            installed.forEach(v => sel.add(new Option(v.display, v.id)));
            sel.dataset.key = 'local_tts_voice';
            if (s.local_tts_voice) sel.value = s.local_tts_voice;
            sel.disabled = installed.length === 0;
        } else {
            const m = map[provider] || map.edge; // legacy/unknown provider → safe fallback
            const src = document.getElementById(m.src);
            if (src) [...src.options].forEach(o => sel.add(new Option(o.textContent, o.value)));
            sel.dataset.key = m.key;
            const cur = s[m.key];
            if (cur) sel.value = cur;
            sel.disabled = sel.options.length === 0;
        }
    },


    _exitReadMode() {
        this._stopRead();
        this._readMode = 'live';
    },


    _setEl(id, display) {
        const el = document.getElementById(id);
        if (el) el.style.display = display;
    },


    _setSel(selector, display) {
        const el = document.querySelector(selector);
        if (el) el.style.display = display;
    },


    /** Capability = usability, not method existence. Returns {ok, reason, provider}. */
    async _readCapability() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';
        const tts = this._getActiveTTS();
        if (typeof tts.synthesize !== 'function') {
            return { ok: false, reason: 'This TTS provider does not support Read mode. Choose Edge, Local, Microsoft, Google, or TikTok.' };
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            return { ok: false, reason: 'Missing Google Cloud API key (Settings → TTS → Google).' };
        }
        if (provider === 'tiktok' && !settings.tiktok_session_id) {
            return { ok: false, reason: 'Missing TikTok sessionid (Settings → TTS → TikTok).' };
        }
        if (provider === 'local') {
            const installed = await this._isLocalVoiceInstalled(settings.local_tts_voice);
            if (!installed) return { ok: false, reason: 'Local voice model not installed (Settings → TTS → Local).' };
        }
        return { ok: true, provider };
    },


    async _showReadCapabilityHint() {
        const hintEl = document.getElementById('read-hint');
        const cap = await this._readCapability();
        const playBtn = document.getElementById('btn-read-play');
        if (this._readMode !== 'read') return;
        if (hintEl) hintEl.textContent = cap.ok ? '' : cap.reason;
        if (playBtn) playBtn.disabled = !cap.ok;
    },


    async _startRead() {
        const cap = await this._readCapability();
        if (!cap.ok) { this._showReadCapabilityHint(); return; }

        const text = (document.getElementById('read-input')?.value || '').trim();
        if (!text) { this._showToast('Enter text to read', 'error'); return; }

        const settings = settingsManager.get();
        const provider = cap.provider;
        const tts = this._getActiveTTS();
        this._configureTTS(tts, settings); // set voice/key/session + client rate

        // Client-side rate: only providers without a server rate param.
        const clientRate = provider === 'google-free' ? (settings.google_free_speed || 1.0)
            : provider === 'tiktok' ? (settings.tiktok_speed || 1.0) : 1.0;
        readAudioPlayer.setReadRate(clientRate);

        const lookahead = provider === 'local' ? 2 : 1;
        const interChunkDelayMs = (provider === 'google-free' || provider === 'tiktok') ? 250 : 0;
        const maxLen = READ_MAX_LEN[provider] || 120;

        this._reader?.stop(); // never leak a previous (e.g. paused) reader — it could race audio
        readAudioPlayer.stop();
        this._reader = new Reader({
            synthesize: (t) => tts.synthesize(t),
            player: readAudioPlayer,
            lookahead,
            interChunkDelayMs,
        });
        this._reader.onProgress = (n, total) => this._updateReadProgress(n, total);
        this._reader.onSentence = (i) => this._highlightReadChunk(i);
        this._reader.onChunkError = (i) => this._markReadChunkError(i);
        this._reader.onError = (msg) => this._showToast(msg, 'error');
        this._reader.onState = (state) => this._onReadState(state);

        this._reader.load(text, maxLen);
        if (this._reader.total === 0) { this._showToast('No content to read', 'error'); return; }
        this._renderReadChunks(this._reader.chunks);
        this._reader.play();
    },


    _stopRead() {
        this._reader?.stop();
        this._reader = null;
        this._resetReadUI();
    },


    _onReadState(state) {
        if (state === 'playing') this._updateReadControls('playing');
        else if (state === 'paused') this._updateReadControls('paused');
        else if (state === 'done' || state === 'stopped') {
            this._updateReadControls('idle');
        }
    },


    _updateReadControls(mode) {
        // mode: 'idle' | 'playing' | 'paused'
        if (mode === 'idle') {
            this._setEl('btn-read-play', '');
            this._setEl('btn-read-pause', 'none');
            this._setEl('btn-read-stop', 'none');
            this._setEl('read-input', '');
            this._setEl('read-output', 'none');
        } else if (mode === 'playing') {
            this._setEl('btn-read-play', 'none');
            this._setEl('btn-read-pause', '');
            this._setEl('btn-read-stop', '');
            this._setEl('read-input', 'none');
            this._setEl('read-output', '');
        } else if (mode === 'paused') {
            this._setEl('btn-read-play', ''); // play acts as resume
            this._setEl('btn-read-pause', 'none');
            this._setEl('btn-read-stop', '');
        }
    },


    _resetReadUI() {
        this._updateReadControls('idle');
        const out = document.getElementById('read-output');
        if (out) out.innerHTML = '';
        const prog = document.getElementById('read-progress');
        if (prog) prog.textContent = '';
        const fill = document.getElementById('read-progress-fill');
        if (fill) fill.style.width = '0%';
    },


    /** Build chunk spans with textContent (never innerHTML) — pasted text is untrusted. */
    _renderReadChunks(chunks) {
        const out = document.getElementById('read-output');
        if (!out) return;
        out.innerHTML = '';
        chunks.forEach((c, i) => {
            const span = document.createElement('span');
            span.className = 'read-chunk';
            span.dataset.index = String(i);
            span.textContent = c + ' ';
            out.appendChild(span);
        });
    },


    _highlightReadChunk(index) {
        const out = document.getElementById('read-output');
        if (!out) return;
        out.querySelectorAll('.read-chunk.active').forEach((el) => el.classList.remove('active'));
        const span = out.querySelector(`.read-chunk[data-index="${index}"]`);
        if (span) {
            span.classList.add('active');
            span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    },


    _markReadChunkError(index) {
        const span = document.getElementById('read-output')
            ?.querySelector(`.read-chunk[data-index="${index}"]`);
        if (span) span.classList.add('error');
    },


    _updateReadProgress(n, total) {
        const prog = document.getElementById('read-progress');
        if (prog) prog.textContent = `chunk ${n}/${total}`;
        const fill = document.getElementById('read-progress-fill');
        if (fill) fill.style.width = total ? `${Math.round((n / total) * 100)}%` : '0%';
    }

};
