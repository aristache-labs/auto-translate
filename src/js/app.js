/**
 * App — main application controller
 * Wires together: settings, UI, STT clients, and audio capture
 */

import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { elevenLabsTTS } from './elevenlabs-tts.js';
import { googleTTS } from './google-tts.js';
import { edgeTTSRust } from './edge-tts.js';
import { microsoftTTS } from './microsoft-tts.js';
import { googleFreeTTS } from './google-free-tts.js';
import { tiktokTTS } from './tiktok-tts.js';
import { localTTS } from './local-tts.js';
import { audioPlayer } from './audio-player.js';
import { sessionStore } from './session-store.js';
import { groqClient } from './groq-client.js';
import { cloudflareClient } from './cloudflare-client.js';
import { assemblyaiClient } from './assemblyai-client.js';
import {
    getSttStartOrder,
    clearSessionState,
} from './provider-orchestrator.js';
import {
    migrateTranslationMode,
    missingRequiredIds,
    showFatalInitError,
} from './mode-utils.js';
import {
    getActivity,
    setLiveBadge,
    initWindowModes,
    startAutoHideWatch,
    stopAutoHideWatch,
    toggleManualCompact,
    revealChrome,
    restoreChrome,
} from './ui-shell.js';
import { appSettingsMethods } from './app-settings.js';
import { appTtsMethods } from './app-tts.js';
import { appReadMethods } from './app-read.js';
import { appLiveMethods } from './app-live.js';
import { appLibraryMethods } from './app-library.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

class App {

    constructor() {
        this.isRunning = false;
        this.isStarting = false; // Guard against re-entry
        this.currentSource = 'system'; // 'system' | 'microphone' | 'both'
        this.translationMode = 'automatic';
        this.groqClient = groqClient;
        this.cloudflareClient = cloudflareClient;
        this.assemblyaiClient = assemblyaiClient;
        this.activeSttProvider = null;
        this.activeSttClient = null;
        this._sttGeneration = 0;
        this._captureStarted = false;
        this._handoffBuffer = [];
        this._translationJobs = new Map();
        this._translationQueue = Promise.resolve();
        this._liveTranslationGen = 0;
        this._liveSourceText = '';
        this._liveSourceLang = null;
        this._liveSentText = '';
        this._liveSentAt = 0;
        this._liveTranslateTimer = null;
        this._fallbackInFlight = false;
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow();
        this.localPipelineChannel = null;
        this.localPipelineReady = false;
        this.recordingStartTime = null;
        this.sessionStartTime = null;  // Session start timestamp (new Date())
        this.sessionSourceLang = 'auto';
        this.sessionTargetLang = 'vi';
        this.sessionMode = 'one_way';
        this.ttsEnabled = false;  // TTS runtime toggle
        this.isPinned = true;     // Always-on-top state
        this.isCompact = false;   // Compact mode (hide control bar)
        this._closing = false;    // Guard so the exit flush runs exactly once
    }


    async init() {
        // Load settings
        await settingsManager.load();

        // Init transcript UI
        const transcriptContainer = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(transcriptContainer);

        // Init session store — one session file lives across many Start/Pause
        // cycles; it autosaves while recording and finalizes on Stop or app close.
        const initSettings = settingsManager.get();
        sessionStore.init({
            engine: initSettings.translation_mode || 'groq',
            sourceLang: initSettings.source_language || 'auto',
            targetLang: initSettings.target_language || 'vi',
        });

        // Check platform — hide Local MLX on non-Apple-Silicon
        await this._checkPlatformSupport();

        // Apply saved settings to UI
        this._applySettings(settingsManager.get());

        const missing = missingRequiredIds(document);
        if (missing.length) {
            throw new Error(`Missing required elements: ${missing.join(', ')}`);
        }

        // Bind event listeners
        this._bindEvents();
        this._bindProviderClients();

        // Flush the session on every close route (window ✕, Cmd+Q, Dock quit).
        await this._bindCloseHooks();

        // Bind keyboard shortcuts
        this._bindKeyboardShortcuts();

        // Subscribe to settings changes
        settingsManager.onChange((settings) => this._applySettings(settings));

        // Init audio player for TTS
        audioPlayer.init();

        // Read mode (in-overlay TTS reader). 'live' = capture→translate→speak; 'read' =
        // paste text → read aloud. Default live. Reader is built lazily on Play.
        this._readMode = 'live';
        this._reader = null;
        this._initReadMode();

        // Wire TTS audio callbacks for every provider (single source of registration
        // so a new provider can never be silently left unwired).
        this._allTTS = [elevenLabsTTS, edgeTTSRust, googleTTS, microsoftTTS, googleFreeTTS, tiktokTTS, localTTS];
        for (const tts of this._allTTS) {
            tts.onAudioChunk = (base64Audio, isFinal) => {
                audioPlayer.enqueue(base64Audio);
            };
            tts.onError = (error) => {
                console.error('[TTS]', error);
                this._showToast(error, 'error');
            };
        }

        // Window position restore disabled — causes issues on Retina displays
        // await this._restoreWindowPosition();

        // Window modes: overlay ↔ expanded (⤢), restores last mode + sizes
        initWindowModes(this.appWindow);

        // Check for updates (non-blocking)
        this._initAboutTab();
        this._checkForUpdates();

        // Show engine picker on first launch
        this._maybeShowEnginePicker();

        console.log('🌐 My Translator v0.7.1 initialized');
    }


    async _checkPlatformSupport() {
        try {
            // Apple Silicon detection must be Rosetta-proof: the x64 build on an
            // ARM Mac reports arch "x86_64" but is_arm_hardware asks the real CPU.
            // MLX runs as a native-ARM Python subprocess, so it works even when
            // the app binary itself is x64-under-Rosetta.
            const arch = await invoke('get_platform_info');
            const info = JSON.parse(arch);
            this._platformOs = info.os; // 'macos' | 'windows' | 'linux'
            this.isAppleSilicon = info.is_arm_hardware === true
                || (info.os === 'macos' && info.arch === 'aarch64');
        } catch {
            // Fallback: check via navigator
            this._platformOs = navigator.userAgent.includes('Mac OS X') ? 'macos'
                : navigator.userAgent.includes('Windows') ? 'windows' : 'linux';
            this.isAppleSilicon = navigator.platform === 'MacIntel' &&
                navigator.userAgent.includes('Mac OS X');
        }

        if (!this.isAppleSilicon) {
            // Keep Local MLX SELECTABLE — don't hard-block. We highlight a warning
            // when the user picks it (see _updateModeUI) and stop them at Start
            // (see start()) so they can't crash into an unsupported runtime.
            // Local TTS is CPU-based and unaffected; only the MLX engine needs
            // macOS Apple Silicon.
            const select = document.getElementById('select-translation-mode');
            const localOption = select?.querySelector('option[value="local"]');
            if (localOption) {
                // Platform-accurate label: Mac Intel needs Apple Silicon;
                // Windows/Linux aren't supported at all.
                const reason = this._platformOs === 'macos'
                    ? ' — needs Apple Silicon'
                    : ' — macOS Apple Silicon only';
                localOption.textContent += reason;
            }

        }
    }


    // ─── Event Binding ──────────────────────────────────────

    _on(id, event, handler) {
        const el = document.getElementById(id);
        if (!el) return false;
        el.addEventListener(event, handler);
        return true;
    }


    _setSelectValue(id, value) {
        const select = document.getElementById(id);
        if (!select || !value) return;
        if (![...select.options].some((opt) => opt.value === value)) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = value;
            select.appendChild(opt);
        }
        select.value = value;
    }


    _bindEvents() {
        this._bindChrome();
        this._bindLiveControls();
        this._bindLibrary();
        this._bindSettingsFormEvents();
        this._bindEnginePicker();
        this._bindTtsControls();
    }


    _bindChrome() {
        // Settings button
        document.getElementById('btn-settings').addEventListener('click', () => {
            this._showView('settings');
        });

        // Back from settings
        document.getElementById('btn-back').addEventListener('click', () => {
            this._showView('overlay');
        });

        // Back from session viewer to session list
        document.getElementById('btn-session-back-to-list').addEventListener('click', () => {
            document.getElementById('sessions-list-panel').style.display = '';
            document.getElementById('session-viewer').style.display = 'none';
        });

        // Copy session content
        document.getElementById('btn-session-copy').addEventListener('click', async () => {
            const content = document.getElementById('session-viewer-content')?.textContent || '';
            if (content) {
                await navigator.clipboard.writeText(content);
                this._showToast('Copied to clipboard', 'success');
            }
        });

        // Session search box (debounced)
        const searchInput = document.getElementById('input-session-search');
        if (searchInput) {
            let t;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(t);
                const q = e.target.value;
                t = setTimeout(() => this._showSessions(q), 200);
            });
        }

        // Edit session title (inline prompt)
        document.getElementById('btn-session-edit-title')?.addEventListener('click', async () => {
            const cur = this._currentViewedSession;
            if (!cur || cur.isLegacy) {
                this._showToast('Cannot rename legacy sessions', 'error');
                return;
            }
            const titleEl = document.getElementById('session-viewer-title');
            const oldTitle = titleEl?.textContent || '';
            const newTitle = prompt('Rename session:', oldTitle);
            if (newTitle == null || newTitle === oldTitle) return;
            try {
                await invoke('update_session_title', { id: cur.id, title: newTitle });
                if (titleEl) titleEl.textContent = newTitle;
                this._showToast('Renamed', 'success');
            } catch (err) {
                this._showToast(`Rename failed: ${err}`, 'error');
            }
        });

        // Export session
        document.getElementById('btn-session-export-srt')?.addEventListener('click', () => this._exportCurrentSession('srt'));
        document.getElementById('btn-session-export-txt')?.addEventListener('click', () => this._exportCurrentSession('txt'));

        // Close button (overlay) — flows through the onCloseRequested hook,
        // which flushes the session before the app exits.
        document.getElementById('btn-close').addEventListener('click', async () => {
            await this._saveWindowPosition();
            await this.appWindow.close();
        });

        // (Minimize button removed from toolbar — ⌘M / window menu still work)

        // Pin/Unpin button
        document.getElementById('btn-pin').addEventListener('click', () => {
            this._togglePin();
        });

        // Compact mode button
        document.getElementById('btn-compact').addEventListener('click', () => {
            this._toggleCompact();
        });

        // Always-available escape hatch when Compact/auto-hide conceals the toolbar.
        document.getElementById('btn-restore-toolbar')?.addEventListener('click', () => {
            restoreChrome();
            this.isCompact = false;
        });

        // View mode toggle (dual panel)
        document.getElementById('btn-view-mode').addEventListener('click', () => {
            this._toggleViewMode();
        });

        // Font size quick controls
        document.getElementById('btn-font-up').addEventListener('click', () => this._adjustFontSize(4));
        document.getElementById('btn-font-down').addEventListener('click', () => this._adjustFontSize(-4));

        // Color dot controls
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                const color = dot.dataset.color;
                this.transcriptUI.configure({ fontColor: color });
            });
        });

    }


    _bindLiveControls() {
        // Start/Stop button
        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.isStarting) return; // Prevent re-entry
            try {
                if (this.isRunning) {
                    await this.stopSession();
                } else {
                    this.isStarting = true;
                    await this.start();
                }
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                this._showToast(`Error: ${err}`, 'error');
                this.isRunning = false;
                this._updateStartButton();
                this._updateStatus('error');
                this.transcriptUI.clear();
                this.transcriptUI.showPlaceholder();
            } finally {
                this.isStarting = false;
            }
        });

        // Pause button — stop capture + persist, but keep the same session file.
        // Only reachable while running (disabled otherwise); next Start appends a
        // new chunk to the same file rather than starting a fresh one.
        document.getElementById('btn-pause')?.addEventListener('click', async () => {
            if (this.isStarting || !this.isRunning) return;
            try {
                await this.pause();
            } catch (err) {
                console.error('[App] Pause error:', err);
                this._showToast(`Error: ${err}`, 'error');
            }
        });

        // Source buttons
        // Audio source dropdown (⌘1/2/3 still switch via _setSource)
        document.getElementById('select-audio-source')?.addEventListener('change', (e) => {
            this._setSource(e.target.value);
        });

        // Clear button — clears display only (auto-save happens on stop)
        document.getElementById('btn-clear').addEventListener('click', async () => {
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.recordingStartTime = null;
        });

        // Copy transcript button
        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                this._showToast('Copied to clipboard', 'success');
            } else {
                this._showToast('Nothing to copy', 'info');
            }
        });

    }


    _bindLibrary() {
        // Open saved transcripts folder (kept for Finder access)
        document.getElementById('btn-open-transcripts').addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                this._showToast('Failed to open folder: ' + err, 'error');
            }
        });

        // Session list/viewer buttons already bound in _bindChrome / here
    }


    _bindProviderClients() {
        this._wireProviderClient(this.groqClient);
        this._wireProviderClient(this.cloudflareClient);
        this._wireProviderClient(this.assemblyaiClient);
    }


    // ─── Keyboard Shortcuts ─────────────────────────────────

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ignore when typing in input fields (SELECT: keep native typeahead)
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
                return;
            }

            // Cmd/Ctrl + Enter: Start/Stop
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.isStarting) return;
                (async () => {
                    try {
                        if (this.isRunning) {
                            await this.stopSession();
                        } else {
                            this.isStarting = true;
                            await this.start();
                        }
                    } catch (err) {
                        console.error('[App] Keyboard start/stop error:', err);
                        this._showToast(`Error: ${err}`, 'error');
                        this.isRunning = false;
                        this._updateStartButton();
                        this._updateStatus('error');
                    } finally {
                        this.isStarting = false;
                    }
                })();
            }

            // Escape: Go back to overlay / close settings
            if (e.key === 'Escape') {
                e.preventDefault();
                // Shortcut sheet closes first if open
                const sheet = document.getElementById('shortcut-sheet');
                if (sheet && sheet.style.display !== 'none') {
                    this._toggleShortcutSheet?.(false);
                    return;
                }
                const settingsVisible = document.getElementById('settings-view').classList.contains('active');
                if (settingsVisible) {
                    this._showView('overlay');
                }
            }

            // "?": shortcut cheat-sheet (guarded above from input/textarea)
            if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                this._toggleShortcutSheet?.(true);
            }

            // Cmd/Ctrl + ,: Open settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            // Cmd/Ctrl + 1: Switch to System Audio
            if ((e.metaKey || e.ctrlKey) && e.key === '1') {
                e.preventDefault();
                this._setSource('system');
            }

            // Cmd/Ctrl + 2: Switch to Microphone
            if ((e.metaKey || e.ctrlKey) && e.key === '2') {
                e.preventDefault();
                this._setSource('microphone');
            }

            // Cmd/Ctrl + 3: Switch to Both
            if ((e.metaKey || e.ctrlKey) && e.key === '3') {
                e.preventDefault();
                this._setSource('both');
            }

            // Cmd/Ctrl + T: Toggle TTS
            if ((e.metaKey || e.ctrlKey) && e.key === 't') {
                e.preventDefault();
                this._toggleTTS();
            }

            // Cmd/Ctrl + M: Minimize
            if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                e.preventDefault();
                this._saveWindowPosition();
                this.appWindow.minimize();
            }

            // Cmd/Ctrl + P: Toggle Pin
            if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
                e.preventDefault();
                this._togglePin();
            }

            // Cmd/Ctrl + D: Toggle Compact
            if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
                e.preventDefault();
                this._toggleCompact();
            }
        });
    }


    // ─── Views ──────────────────────────────────────────────

    _showView(view) {
        document.getElementById('overlay-view').classList.toggle('active', view === 'overlay');
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');

        if (view === 'settings') {
            this._populateSettingsForm();
            this._showSettingsScreen('settings-home'); // wizard always opens at home
        }
        // Returning to the overlay while in Read mode: a voice/provider may have
        // changed in Settings — refresh both the capability hint AND the voice
        // quick-pick (else it keeps the old provider's options + settings key).
        if (view === 'overlay' && getActivity() === 'read') {
            this._populateReadQuickPick();
            this._showReadCapabilityHint();
        }
    }


    /** Wizard: show one settings screen (home or a detail) inside the settings view. */
    _showSettingsScreen(id) {
        if (!id || !document.getElementById(id)) id = 'settings-home';
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(id).classList.add('active');
        if (id === 'settings-home') this._updateSettingsCards();
        document.querySelector('.settings-body')?.scrollTo(0, 0);
    }


    /** Wizard: refresh the home cards' status subtitles from current settings. */
    _updateSettingsCards() {
        const s = settingsManager.get();
        const mode = migrateTranslationMode(s.translation_mode);
        const engineNames = {
            automatic: 'Auto',
            assemblyai: 'AssemblyAI',
            groq: 'Groq',
            cloudflare: 'Cloudflare',
            local: 'Local MLX',
        };
        const keyField = { groq: 'groq_api_key', assemblyai: 'assemblyai_api_key' };
        const hasCloudflareKey = !!(s.cloudflare_account_id || '').trim() && !!(s.cloudflare_api_token || '').trim();
        const hasKey = mode === 'local'
            || (mode === 'automatic'
                ? getSttStartOrder(s, this._platformContext()).length > 0
                : mode === 'cloudflare'
                    ? hasCloudflareKey
                    : !!(s[keyField[mode]] || '').trim());
        const subT = document.getElementById('card-translation-sub');
        if (subT) {
            const llm = s.llm_provider || 'automatic';
            const llmNames = { automatic: 'Auto', openrouter: 'OpenRouter', engine: 'Engine' };
            const llmName = mode === 'local' ? 'Local' : (llmNames[llm] || 'Auto');
            subT.textContent =
                `STT ${engineNames[mode] || mode} · LLM ${llmName} · ${s.source_language || 'auto'} → ${s.target_language || 'vi'}` +
                (hasKey ? '' : ' · ⚠️ missing API key');
        }

        // TTS card: cloud-realtime engines run text-only — reflect on the card, never hide.
        const isCloudRealtime = false;
        const provNames = {
            edge: 'Edge TTS', microsoft: 'Microsoft v2', 'google-free': 'Google TTS Free',
            tiktok: 'TikTok TTS', local: 'Local (Offline)', google: 'Google Chirp HD', elevenlabs: 'ElevenLabs',
        };
        const cardTts = document.getElementById('card-tts');
        const subTts = document.getElementById('card-tts-sub');
        if (cardTts) cardTts.classList.toggle('disabled', isCloudRealtime);
        if (subTts) {
            if (isCloudRealtime) {
                subTts.textContent = `Off — ${engineNames[mode]} engine is text-only, no speech`;
            } else {
                const prov = s.tts_provider || 'edge';
                const voice = prov === 'local' && s.local_tts_voice ? ` · ${s.local_tts_voice}` : '';
                subTts.textContent = `${provNames[prov] || prov}${voice}`;
            }
        }
    }


    // ─── Source Control ────────────────────────────────────

    _setSource(source) {
        const wasRunning = this.isRunning;
        const labels = { system: 'System Audio', microphone: 'Microphone', both: 'System + Mic' };
        const label = labels[source] || source;
        // Persist so subsequent settings notifications don't reset us back.
        settingsManager.save({ audio_source: source });

        if (wasRunning) {
            this.pause().then(() => {
                this.currentSource = source;
                this._updateSourceButtons();
                this._showToast(`Switched to ${label}`, 'success');
                this.start();
            });
        } else {
            this.currentSource = source;
            this._updateSourceButtons();
            this._showToast(`Source: ${label}`, 'success');
        }
    }


    _updateSourceButtons() {
        const sel = document.getElementById('select-audio-source');
        if (sel) sel.value = this.currentSource;
    }


    // ─── Start/Stop ────────────────────────────────────────

    async start() {
        const settings = settingsManager.get();
        this.translationMode = migrateTranslationMode(settings.translation_mode);
        console.log('[App] start() called, translation_mode:', this.translationMode, 'activeSttProvider:', this.activeSttProvider, 'isRunning:', this.isRunning);

        if (this.translationMode === 'local' && !this.isAppleSilicon) {
            this._showToast('Local MLX only runs on macOS Apple Silicon. Choose another engine in Settings.', 'error');
            this._showView('settings');
            return;
        }

        const startOrder = getSttStartOrder(settings, this._platformContext());
        console.log('[App] STT start order:', startOrder, 'assemblyai_key:', !!settings.assemblyai_api_key, 'groq_key:', !!settings.groq_api_key);
        if (!startOrder.length) {
            this._showToast('No STT providers are configured. Add credentials in Settings.', 'error');
            this._showView('settings');
            return;
        }

        if (this.ttsEnabled && settings.tts_provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('TTS is ON but ElevenLabs API key is missing. Add it in Settings or disable TTS.', 'error');
            this._showView('settings');
            return;
        }

        this._hideEnginePicker();
        this._setEnginePillLocked(true);
        if (!this.recordingStartTime) this.recordingStartTime = Date.now();

        if (!this.sessionStartTime) {
            this.sessionStartTime = new Date();
            const translationType = settings.translation_type || 'one_way';
            this.sessionMode = translationType;
            if (translationType === 'two_way') {
                this.sessionSourceLang = settings.language_a || 'ja';
                this.sessionTargetLang = settings.language_b || 'vi';
            } else {
                this.sessionSourceLang = settings.source_language || 'auto';
                this.sessionTargetLang = settings.target_language || 'vi';
            }
        }

        sessionStore.beginChunk({
            engine: this.translationMode,
            sourceLang: this.sessionSourceLang,
            targetLang: this.sessionTargetLang,
        });

        if (!this.transcriptUI.hasContent()) {
            this.transcriptUI.showListening();
        } else {
            this.transcriptUI.clearProvisional();
        }

        try {
            this._bindProviderClients();
            await this._startSessionCapture();
            let started = false;
            for (const provider of startOrder) {
                started = await this._connectSttProvider(provider);
                if (started) break;
            }
            if (!started) throw new Error('No STT provider could start');
            this.isRunning = true;
            this._updateStartButton();
        } catch (err) {
            console.error('[App] start failed:', err);
            this._showToast(`Start failed: ${err?.message || err}`, 'error');
            await this._restoreStoppedState();
            return;
        }

        if (this.ttsEnabled) {
            const tts = this._getActiveTTS();
            this._configureTTS(tts, settings);
            tts.connect();
            audioPlayer.resume();
        }
    }


    async _restoreStoppedState() {
        this.isRunning = false;
        this.isStarting = false;
        this._fallbackInFlight = false;
        this.activeSttProvider = null;
        this.activeSttClient = null;
        this._handoffBuffer = [];
        this._translationJobs.clear();
        this._translationQueue = Promise.resolve();
        this._invalidateLiveTranslation();
        clearSessionState();
        this._setEnginePillLocked(false);
        this._updateStartButton();
        this._updateStatus('disconnected');
        await this._disconnectAllStt();
        try { await this._stopSessionCapture(); } catch { /* already stopped */ }
    }


    // Pause: stop capture and persist the current chunk, but keep the session
    // file open. The next Start appends a new chunk to the same file. Finalizing
    // into a new file is stopSession()'s job.
    async pause() {
        this.isRunning = false;
        this._updateStartButton();
        this._setEnginePillLocked(false);

        // Stop audio capture once
        try {
            await this._stopSessionCapture();
        } catch (err) {
            console.error('Failed to stop audio capture:', err);
        }

        await this._disconnectAllStt();
        this.activeSttProvider = null;
        this.activeSttClient = null;
        this._flushOpenTurnBeforeStop();
        this._invalidateLiveTranslation();
        this._updateStatus('disconnected');

        // Keep finalized transcript visible — don't clear segments
        this.transcriptUI.clearProvisional();

        // Stop TTS
        elevenLabsTTS.disconnect();
        edgeTTSRust.disconnect();

        audioPlayer.stop();

        // Drain any leftover Soniox originals that didn't get paired
        if (this._sonioxOriginalQueue) this._sonioxOriginalQueue.length = 0;

        // Close the chunk and persist the whole session (md + json sidecar).
        // Transcript stays on screen — clearSession is no longer called here
        // so user can review & continue in next chunk.
        sessionStore.endChunk();
        const result = await sessionStore.persist();
        if (result === 'saved') {
            const n = sessionStore.totalSegmentCount();
            this._showToast(`Saved ${n} segment${n === 1 ? '' : 's'}`, 'success');
        } else if (result === 'failed') {
            this._showToast('Save failed — session kept in memory', 'error');
        }
        // 'skipped' → data already on disk or nothing to save; no toast.

        // sessionStartTime stays — pausing keeps the same session file, which
        // lives across many Start/Pause cycles. stopSession() resets it.
    }


    // Stop: pause (if running), finalize the current session file, then start a
    // fresh session so the next Start writes a new file pair. Keeps the
    // transcript on screen. Never wipes in-memory data on a failed save.
    async stopSession() {
        if (this.isRunning) await this.pause();

        if (sessionStore.isEmpty()) {
            this._showToast('Nothing to save', 'success');
        } else {
            const result = await sessionStore.endSession();
            if (result === 'failed') {
                // Keep the in-memory session intact so the user can retry Stop.
                this._showToast('Save failed — session kept in memory', 'error');
                return;
            }
            this._showToast('Session saved — next start creates a new one', 'success');
        }

        // Reset session identity: fresh ID + current settings so the next Start
        // writes a new file. Resetting sessionStartTime forces start() to
        // re-stamp the metadata block with the current language pair.
        this.sessionStartTime = null;
        const settings = settingsManager.get();
        sessionStore.init({
            engine: settings.translation_mode || 'soniox',
            sourceLang: settings.source_language || 'auto',
            targetLang: settings.target_language || 'vi',
        });
    }


    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }


    // Persist the session on the way out. endSession() first (cheap local write
    // that finalizes the file), then best-effort engine teardown via pause().
    // Both are idempotent, so running this more than once is harmless.
    async _flushOnExit() {
        try { await sessionStore.endSession(); } catch (e) { console.error('[App] exit flush (endSession) failed:', e); }
        try { await this.pause(); } catch (e) { console.error('[App] exit flush (pause) failed:', e); }
    }


    // Two close routes, one flush:
    //  • window ✕ / appWindow.close() → onCloseRequested (frontend)
    //  • Cmd+Q / Dock quit → Rust RunEvent::ExitRequested emits 'app-exit-requested'
    // Both flush (raced against a 3s deadline so a hung engine can't wedge the
    // app) then exit_app, which force-exits the process cleanly in Rust.
    async _bindCloseHooks() {
        await this.appWindow.onCloseRequested(async (event) => {
            if (this._closing) return;
            this._closing = true;
            event.preventDefault();
            await Promise.race([this._flushOnExit(), this._sleep(3000)]);
            try {
                await invoke('exit_app');
            } catch {
                try { await this.appWindow.destroy(); } catch {}
            }
        });

        await this.appWindow.listen('app-exit-requested', async () => {
            if (this._closing) return;
            this._closing = true;
            await Promise.race([this._flushOnExit(), this._sleep(3000)]);
            try { await invoke('exit_app'); } catch {}
        });
    }


    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');

        btn.classList.toggle('recording', this.isRunning);
        iconPlay.style.display = this.isRunning ? 'none' : 'block';
        iconStop.style.display = this.isRunning ? 'block' : 'none';
        const label = document.getElementById('btn-start-label');
        if (label) label.textContent = this.isRunning ? 'Stop' : 'Start';

        // Pause is only actionable while running. (Don't also gate on isStarting:
        // start() calls this while isStarting is still true, and the click handler
        // already guards the starting window.)
        const btnPause = document.getElementById('btn-pause');
        if (btnPause) btnPause.disabled = !this.isRunning;
    }


    // ─── Status ────────────────────────────────────────────

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');

        dot.className = 'status-dot';

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = 'Connecting...';
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = 'Listening';
                break;
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = 'Ready';
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Error';
                break;
        }
        // Live tab shows a red badge while a session runs so the user sees
        // recording state even from the Read / Library activities.
        setLiveBadge(this.isRunning);
        // Auto-hide chrome only while translating (idle 3s → hide, hover/keys → show)
        if (this.isRunning) startAutoHideWatch();
        else stopAutoHideWatch();
    }


    // ─── Window Position ───────────────────────────────────

    async _saveWindowPosition() {
        try {
            const factor = await this.appWindow.scaleFactor();
            const pos = await this.appWindow.outerPosition();
            const size = await this.appWindow.innerSize();
            // Save logical coordinates (physical / scaleFactor)
            localStorage.setItem('window_state', JSON.stringify({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                width: Math.round(size.width / factor),
                height: Math.round(size.height / factor),
            }));
        } catch (err) {
            console.error('Failed to save window position:', err);
        }
    }


    async _restoreWindowPosition() {
        try {
            const saved = localStorage.getItem('window_state');
            if (!saved) return;

            const state = JSON.parse(saved);
            const { LogicalPosition, LogicalSize } = window.__TAURI__.window;

            // Validate — don't restore if position seems off-screen
            if (state.x < -100 || state.y < -100 || state.x > 5000 || state.y > 3000) {
                console.warn('Saved window position looks off-screen, skipping restore');
                localStorage.removeItem('window_state');
                return;
            }

            if (state.width && state.height && state.width >= 300 && state.height >= 100) {
                await this.appWindow.setSize(new LogicalSize(state.width, state.height));
            }
            if (state.x !== undefined && state.y !== undefined) {
                await this.appWindow.setPosition(new LogicalPosition(state.x, state.y));
            }
        } catch (err) {
            console.error('Failed to restore window position:', err);
            localStorage.removeItem('window_state');
        }
    }


    // ─── Pin / Unpin (Always on Top) ────────────────────

    async _togglePin() {
        this.isPinned = !this.isPinned;
        await this.appWindow.setAlwaysOnTop(this.isPinned);
        const btn = document.getElementById('btn-pin');
        if (btn) btn.classList.toggle('active', this.isPinned);
        this._showToast(this.isPinned ? 'Pinned on top' : 'Unpinned — window can go behind other apps', 'success');
    }


    // ─── Compact Mode ───────────────────────────────

    _toggleCompact() {
        // Unified with auto-hide in ui-shell — one chrome hide/show mechanism.
        this.isCompact = toggleManualCompact();
    }


    _toggleViewMode() {
        const isDual = this.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.transcriptUI.configure({ viewMode: newMode });
        // The split control lives inside the overflow menu. Keep the action row
        // visible after the menu closes instead of letting an old idle timer win.
        revealChrome();
        const btn = document.getElementById('btn-view-mode');
        if (btn) btn.classList.toggle('active', newMode === 'dual');
    }


    _adjustFontSize(delta) {
        const current = this.transcriptUI.fontSize || 16;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.transcriptUI.configure({ fontSize: newSize });

        // Update display
        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;

        // Sync with settings slider
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
    }


    _showToast(message, type = 'success') {
        const text = String(message ?? '');
        if (type === 'error') console.error('[Toast]', text);
        else if (type === 'info') console.info('[Toast]', text);
        else console.log('[Toast]', text);
        invoke('frontend_log', { level: type, message: text }).catch(() => {});

        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-remove (longer for errors)
        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

Object.assign(App.prototype, appSettingsMethods, appTtsMethods, appReadMethods, appLiveMethods, appLibraryMethods);

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init().catch((err) => showFatalInitError(err));
});

