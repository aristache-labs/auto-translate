/**
 * App live STT connect/failover, translation, and local MLX pipeline.
 * Mixed onto App.prototype from app.js.
 */

import { settingsManager } from './settings.js';
import { sessionStore } from './session-store.js';
import { groqClient } from './groq-client.js';
import { cloudflareClient } from './cloudflare-client.js';
import { assemblyaiClient } from './assemblyai-client.js';
import {
    sanitizeErrorMessage,
    nextSttProvider,
    preferredRecoveryStt,
    canTransitionStt,
    markSttTransition,
    isCircuitBreakerOpen,
    logEngineEvent,
    sttModelFor,
    parseProviderError,
    applyProviderError,
    translateWithChain,
    allocateSegmentId,
    breakerKey,
    noteHalfOpenProbe,
    noteProviderSuccess,
    isCircuitBreakerHalfOpen,
    LIVE_TRANSLATION_TIMEOUT_MS,
    LIVE_TRANSLATION_MIN_INTERVAL_MS,
    LIVE_TRANSLATION_MIN_NEW_WORDS,
    countWords,
    ERROR_TYPES,
} from './provider-orchestrator.js';
import {
    clientConfigFromSettings,
} from './mode-utils.js';

const { invoke, Channel } = window.__TAURI__.core;

export const appLiveMethods = {


    _wireProviderClient(client) {
        if (!client) return;
        client.onStatusChange = (status) => this._updateStatus(status);
        client.onProvisional = (text, speaker, language) => {
            if (client !== this.activeSttClient) {
                console.log(`[live-tx] PROVISIONAL ignored: client mismatch active=${this.activeSttProvider} client=${client.providerId}`);
                return;
            }
            if (text) {
                console.log(`[live-tx] PROVISIONAL chars=${text.length} speaker=${speaker} lang=${language}`);
                this.transcriptUI.setProvisional(text, speaker, language);
                this._onLiveSourcePartial(text, language);
            } else {
                console.log(`[live-tx] PROVISIONAL cleared`);
                this._invalidateLiveTranslation();
                this.transcriptUI.clearProvisional();
            }
        };
        client.onOriginal = (text, speaker, language) => {
            if (client !== this.activeSttClient) {
                console.log(`[live-tx] ORIGINAL ignored: client mismatch`);
                return;
            }
            console.log(`[live-tx] ORIGINAL chars=${text?.length} speaker=${speaker} lang=${language}`);
            console.debug(`[timing] stt.final provider=${client.providerId} chars=${(text || '').length}`);
            this._commitSourceTurn(text, speaker, language);
        };
        client.onError = (error) => {
            const parsed = parseProviderError(error, {
                provider: client.providerId,
                capability: 'stt',
            });
            const sanitized = parsed.message || sanitizeErrorMessage(error);
            if (!this._lastErrorToastAt || Date.now() - this._lastErrorToastAt > 5000) {
                this._lastErrorToastAt = Date.now();
                this._showToast(sanitized, 'error');
            }
        };
        client.onFallback = (reason) => {
            if (client !== this.activeSttClient) return;
            this._failoverStt(parseProviderError(reason, {
                provider: client.providerId,
                capability: 'stt',
            }));
        };
    },


    async _disconnectAllStt() {
        for (const client of [this.assemblyaiClient, this.groqClient, this.cloudflareClient]) {
            try { if (client) await client.disconnect(); } catch { /* ignore */ }
        }
        try { await invoke('stop_local_pipeline'); } catch { /* ignore */ }
        this.localPipelineReady = false;
    },


    async _startSessionCapture() {
        if (this._captureStarted) return;
        const audioChannel = new Channel();
        audioChannel.onmessage = async (pcmData) => {
            const client = this.activeSttClient;
            if (!client) {
                if (this._handoffBuffer.length < 8) this._handoffBuffer.push(pcmData);
                return;
            }
            try {
                await client.sendAudio(pcmData);
            } catch (e) {
                console.warn('[App] Send audio error:', e);
            }
        };
        await invoke('start_capture', {
            source: this.currentSource,
            channel: audioChannel,
        });
        this._captureStarted = true;
    },


    async _stopSessionCapture() {
        if (!this._captureStarted && !this._handoffBuffer.length) {
            try { await invoke('stop_capture'); } catch { /* ignore */ }
            return;
        }
        this._captureStarted = false;
        this._handoffBuffer = [];
        try { await invoke('stop_capture'); } catch { /* ignore */ }
    },


    _clientForProvider(provider) {
        if (provider === 'assemblyai') return this.assemblyaiClient;
        if (provider === 'groq') return this.groqClient;
        if (provider === 'cloudflare') return this.cloudflareClient;
        return null;
    },


    async _connectSttProvider(provider) {
        const settings = settingsManager.get();
        const key = breakerKey('stt', provider);
        if (isCircuitBreakerOpen(key)) return false;
        if (isCircuitBreakerHalfOpen(key)) noteHalfOpenProbe(key);

        this._sttGeneration += 1;
        const previous = this.activeSttClient;
        this.activeSttClient = null;

        if (previous && previous !== this._clientForProvider(provider)) {
            try { await previous.disconnect(); } catch { /* ignore */ }
        }

        try {
            const sttModel = sttModelFor(settings, provider);
            if (provider === 'local-stt' || provider === 'local') {
                logEngineEvent('stt', { event: 'connecting', provider, model: sttModel });
                await this._startLocalMode(settings);
                this.activeSttProvider = 'local-stt';
                this.activeSttClient = this._localAudioAdapter();
            } else {
                logEngineEvent('stt', { event: 'connecting', provider, model: sttModel });
                const client = this._clientForProvider(provider);
                if (!client) {
                    logEngineEvent('stt', { event: 'failed', provider, model: sttModel, reason: 'no client' });
                    return false;
                }
                this._bindProviderClients();
                const config = clientConfigFromSettings(settings, provider === 'cloudflare' ? 'cloudflare' : 'groq');
                if (provider === 'assemblyai') {
                    await client.connect({
                        ...config,
                        region: 'global',
                        model: sttModel || 'universal-streaming-english',
                        speakerLabels: !!settings.assemblyai_speaker_labels,
                        filterProfanity: !!settings.assemblyai_filter_profanity,
                        redactPii: !!settings.assemblyai_redact_pii,
                        minTurnSilenceMs: settings.assemblyai_min_turn_silence_ms ?? 400,
                        maxTurnSilenceMs: settings.assemblyai_max_turn_silence_ms ?? 1280,
                        vadThreshold: settings.assemblyai_vad_threshold ?? 0.4,
                        endOfTurnConfidence: settings.assemblyai_end_of_turn_confidence ?? 0.4,
                    });
                } else {
                    client.connect(config);
                }
                if (!client.isConnected) {
                    throw new Error(`${provider} failed to connect`);
                }
                this.activeSttProvider = provider;
                this.activeSttClient = client;
                this.transcriptUI.provider = provider;
            }
            noteProviderSuccess(key);
            markSttTransition();
            logEngineEvent('stt', { event: 'active', provider: this.activeSttProvider, model: sttModel });
            this._updatePillState(this.activeSttProvider);
            this._updateChainUI();
            const pending = this._handoffBuffer.splice(0);
            for (const chunk of pending) {
                try { this.activeSttClient.sendAudio(chunk); } catch { /* ignore */ }
            }
            return true;
        } catch (err) {
            logEngineEvent('stt', {
                event: 'failed',
                provider,
                model: sttModelFor(settings, provider),
                reason: err?.message || err,
            });
            applyProviderError(parseProviderError(err, { provider, capability: 'stt' }));
            return false;
        }
    },


    _localAudioAdapter() {
        const self = this;
        return {
            providerId: 'local-stt',
            async sendAudio(pcmData) {
                if (!self.localPipelineReady) return;
                try {
                    await invoke('send_audio_to_pipeline', { data: Array.from(new Uint8Array(pcmData)) });
                } catch {
                    /* pipeline may not be ready */
                }
            },
            async disconnect() {
                try { await invoke('stop_local_pipeline'); } catch { /* ignore */ }
                self.localPipelineReady = false;
            },
        };
    },


    async _failoverStt(error) {
        if (this._fallbackInFlight || !this.isRunning) return;
        if (error?.kind === ERROR_TYPES.INTENTIONAL) return;
        this._fallbackInFlight = true;
        try {
            let current = this.activeSttProvider;
            let parsed = applyProviderError(error);
            const settings = settingsManager.get();
            while (this.isRunning) {
                const next = nextSttProvider(settings, this._platformContext(), current);
                if (!next) {
                    this._showToast('All STT providers failed', 'error');
                    await this._restoreStoppedState();
                    return;
                }
                logEngineEvent('stt', {
                    event: 'switch',
                    provider: next,
                    model: sttModelFor(settings, next),
                    previous: current,
                    reason: parsed.message,
                });
                this._showToast(`Switching to ${next}`, 'info');
                const ok = await this._connectSttProvider(next);
                if (ok) return;
                parsed = parseProviderError(`${next} failed to start`, {
                    provider: next,
                    capability: 'stt',
                    status: 503,
                });
                applyProviderError(parsed);
                current = next;
            }
        } finally {
            this._fallbackInFlight = false;
        }
    },


    _flushOpenTurnBeforeStop() {
        const source = (
            this.transcriptUI?.provisionalText
            || this._liveSourceText
            || ''
        ).trim();
        if (!source) return;

        const segments = this.transcriptUI.segments || [];
        const last = segments[segments.length - 1];
        if (last?.original && (last.original === source || source === last.original.trim())) {
            const live = (this.transcriptUI.translationProvisionalText || '').trim();
            if (live && !last.translation) {
                this.transcriptUI.addTranslation(live);
                sessionStore.addSegment(source, live);
            }
            return;
        }

        const live = (this.transcriptUI.translationProvisionalText || '').trim();
        this.transcriptUI.addOriginal(source);
        if (live) {
            this.transcriptUI.addTranslation(live);
            sessionStore.addSegment(source, live);
        } else {
            const segmentId = allocateSegmentId();
            this._translationJobs.set(segmentId, { text: source });
            this._enqueueTranslation(
                segmentId,
                source,
                this._liveSourceLang || this.sessionSourceLang,
            );
        }
        console.debug(`[timing] stt.flush_on_stop chars=${source.length} live=${!!live}`);
    },


    _invalidateLiveTranslation() {
        const oldGen = this._liveTranslationGen;
        this._liveTranslationGen += 1;
        this._liveSourceText = '';
        this._liveSourceLang = null;
        this._liveSentText = '';
        this._liveSentAt = 0;
        if (this._liveTranslateTimer) {
            clearTimeout(this._liveTranslateTimer);
            this._liveTranslateTimer = null;
        }
        this.transcriptUI?.clearTranslationProvisional?.();
        console.log(`[live-tx] INVALIDATED gen ${oldGen} -> ${this._liveTranslationGen}`);
    },


    _onLiveSourcePartial(text, language) {
        const chunk = (text || '').trim();
        if (!chunk || !this.isRunning) {
            console.log(`[live-tx] INVALIDATE: isRunning=${this.isRunning} chunk="${chunk.slice(0, 40)}"`);
            this._invalidateLiveTranslation();
            return;
        }
        this._liveSourceText = chunk;
        this._liveSourceLang = language || this.sessionSourceLang || 'auto';
        const now = Date.now();

        // Fire immediately if enough new words, or after interval has elapsed
        const timeSinceLast = this._liveSentAt ? now - this._liveSentAt : Infinity;
        const newWords = countWords(chunk) - countWords(this._liveSentText);
        const shouldFire = newWords >= LIVE_TRANSLATION_MIN_NEW_WORDS
            || timeSinceLast >= LIVE_TRANSLATION_MIN_INTERVAL_MS;

        console.log(`[live-tx] partial chars=${chunk.length} newWords=${newWords} timeSinceLast=${Math.round(timeSinceLast)}ms shouldFire=${shouldFire} gen=${this._liveTranslationGen}`);

        if (shouldFire) {
            if (this._liveTranslateTimer) {
                clearTimeout(this._liveTranslateTimer);
                this._liveTranslateTimer = null;
            }
            void this._requestLiveTranslation();
            return;
        }
        if (this._liveTranslateTimer) {
            console.log(`[live-tx] scheduled wait=${Math.round(LIVE_TRANSLATION_MIN_INTERVAL_MS - timeSinceLast)}ms`);
            return;
        }
        const wait = Math.max(
            50,
            LIVE_TRANSLATION_MIN_INTERVAL_MS - timeSinceLast,
        );
        console.log(`[live-tx] schedule wait=${Math.round(wait)}ms`);
        this._liveTranslateTimer = setTimeout(() => {
            this._liveTranslateTimer = null;
            void this._requestLiveTranslation();
        }, wait);
    },


    async _requestLiveTranslation() {
        const text = (this._liveSourceText || '').trim();
        if (!text || !this.isRunning) {
            console.log(`[live-tx] ABORT: text="${text?.slice(0, 30)}" isRunning=${this.isRunning}`);
            return;
        }
        if (text === this._liveSentText) {
            console.log(`[live-tx] SKIP: same text chars=${text.length}`);
            return;
        }

        const gen = ++this._liveTranslationGen;
        this._liveSentText = text;
        this._liveSentAt = Date.now();
        const settings = settingsManager.get();
        const language = this._liveSourceLang || this.sessionSourceLang || settings.source_language || 'auto';
        console.log(`[live-tx] REQUEST gen=${gen} chars=${text.length} lang=${language} stt=${this.activeSttProvider}`);

        try {
            const t0 = Date.now();
            const result = await translateWithChain({
                settings,
                activeStt: this.activeSttProvider,
                text,
                sourceLanguage: language,
                targetLanguage: this.sessionTargetLang || settings.target_language || 'vi',
                segmentId: `live_${gen}`,
                generation: gen,
                isCurrent: (_id, g) => g === this._liveTranslationGen && this.isRunning,
                invoke,
                timeoutMs: LIVE_TRANSLATION_TIMEOUT_MS,
                allowRetry: false,
                mode: 'live',
            });
            const elapsed = Date.now() - t0;
            console.log(`[live-tx] RESPONSE gen=${gen} elapsed=${elapsed}ms llm=${result?.provider} ignored=${result?.ignored} chars=${(result?.translatedText || '').length}`);

            if (result?.ignored) {
                console.log(`[live-tx] IGNORED gen=${gen}`);
                return;
            }
            if (gen !== this._liveTranslationGen || !this.isRunning) {
                console.log(`[live-tx] STALE gen=${gen} current=${this._liveTranslationGen} isRunning=${this.isRunning}`);
                return;
            }
            const translated = (result.translatedText || '').trim();
            if (!translated) {
                console.log(`[live-tx] EMPTY result`);
                return;
            }
            console.log(`[live-tx] UPDATE draft="${translated.slice(0, 60)}..."`);
            this.transcriptUI.setTranslationProvisional(translated);
            console.log(`[timing] ui.render mode=live chars=${translated.length}`);
        } catch (err) {
            console.log(`[live-tx] ERROR gen=${gen} err=${err?.message || err}`);
            /* live failures are silent — final path remains authoritative */
        }
        this._scheduleNextLiveTranslation();
    },


    _scheduleNextLiveTranslation() {
        if (!this.isRunning) return;
        const now = Date.now();
        const wait = Math.max(
            50,
            LIVE_TRANSLATION_MIN_INTERVAL_MS - (this._liveSentAt ? now - this._liveSentAt : 0),
        );
        this._liveTranslateTimer = setTimeout(() => {
            this._liveTranslateTimer = null;
            void this._requestLiveTranslation();
        }, wait);
    },


    _commitSourceTurn(text, speaker, language) {
        const chunk = (text || '').trim();
        if (!chunk) return;
        console.log(`[live-tx] FINAL_TURN chars=${chunk.length} speaker=${speaker} lang=${language}`);
        this._invalidateLiveTranslation();
        this.transcriptUI.clearProvisional();
        this.transcriptUI.addOriginal(chunk, speaker, language);
        const segmentId = allocateSegmentId();
        this._translationJobs.set(segmentId, { text: chunk });
        console.log(`[live-tx] enqueue final segment=${segmentId} chars=${chunk.length}`);
        this._enqueueTranslation(segmentId, chunk, language);
        this._maybeRecoverStt();
    },


    _enqueueTranslation(segmentId, text, language) {
        this._translationQueue = this._translationQueue
            .then(() => this._translateSegment(segmentId, text, language))
            .catch(() => { /* errors handled inside _translateSegment */ });
    },


    async _translateSegment(segmentId, text, language) {
        const settings = settingsManager.get();
        const startedAt = Date.now();
        console.log(`[live-tx] final translate segment=${segmentId} chars=${text.length} lang=${language}`);
        try {
            const result = await translateWithChain({
                settings,
                activeStt: this.activeSttProvider,
                text,
                sourceLanguage: language || this.sessionSourceLang || settings.source_language || 'auto',
                targetLanguage: this.sessionTargetLang || settings.target_language || 'vi',
                segmentId,
                generation: segmentId,
                isCurrent: (id) => this._translationJobs.has(id),
                invoke,
                mode: 'final',
            });
            const elapsed = Date.now() - startedAt;
            console.log(`[live-tx] final response segment=${segmentId} elapsed=${elapsed}ms llm=${result?.provider} ignored=${result?.ignored}`);
            if (result?.ignored) return;
            if (!this._translationJobs.has(segmentId)) return;
            const translated = result.translatedText || text;
            this.transcriptUI.addTranslation(translated);
            console.log(`[timing] ui.render mode=final segment=${segmentId} chars=${translated.length} elapsed=${elapsed}ms`);
            this._speakIfEnabled(translated);
            sessionStore.addSegment(text, translated);
            this._translationJobs.delete(segmentId);
        } catch (err) {
            const parsed = parseProviderError(err, { capability: 'translation' });
            console.log(`[live-tx] final ERROR segment=${segmentId} err=${parsed.message || err}`);
            this._showToast(parsed.message || 'Translation failed', 'error');
            if (this._translationJobs.has(segmentId)) {
                sessionStore.addSegment(text, '');
                this._translationJobs.delete(segmentId);
            }
        }
    },


    _maybeRecoverStt() {
        if (!this.isRunning || this._fallbackInFlight) return;
        if (this.transcriptUI.provisionalText) return;
        if (!canTransitionStt()) return;
        const settings = settingsManager.get();
        const better = preferredRecoveryStt(
            settings,
            this._platformContext(),
            this.activeSttProvider,
        );
        if (!better || better === this.activeSttProvider) return;
        if (better === 'assemblyai' && isCircuitBreakerOpen(breakerKey('stt', 'assemblyai'))) return;
        logEngineEvent('stt', {
            event: 'recovery',
            provider: better,
            model: sttModelFor(settings, better),
            previous: this.activeSttProvider,
            reason: 'priority recovery',
        });
        this._showToast(`Restoring ${better}`, 'info');
        void this._connectSttProvider(better);
    },


    async _startGroqMode(settings) {
        return this._connectSttProvider('groq');
    },


    async _startCloudflareMode(settings) {
        return this._connectSttProvider('cloudflare');
    },


    async _transitionToCloudflare() {
        return this._failoverStt(parseProviderError('quota', { provider: 'groq', capability: 'stt', status: 429 }));
    },


    async _startLocalMode(settings) {
        console.log('[App] Starting Local mode (MLX models)...');
        this.transcriptUI.provider = 'local';
        this._updateStatus('connecting');

        // Step 1: Check if MLX setup is complete
        try {
            const checkResult = await invoke('check_mlx_setup');
            const status = JSON.parse(checkResult);
            if (!status.ready) {
                this._showToast('Setting up MLX models (one-time, ~5GB)...', 'success');
                this.transcriptUI.showStatusMessage('Downloading MLX models (one-time setup)...');
                await this._runMlxSetup();
            }
        } catch (err) {
            console.warn('[App] MLX check failed (proceeding anyway):', err);
        }

        console.log('[App] MLX check passed, starting pipeline...');

        // Step 1: Start pipeline FIRST (independent of audio)
        try {
            this._showToast('Starting local pipeline...', 'success');

            this.localPipelineChannel = new window.__TAURI__.core.Channel();
            this.localPipelineReady = false;

            this.localPipelineChannel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    console.warn('[Local] JSON parse failed:', typeof msg, msg);
                    return;
                }
                try {
                    this._handleLocalPipelineResult(data);
                } catch (e) {
                    console.error('[Local] Handler error for type:', data?.type, e);
                }
            };

            const sourceLangMap = {
                'auto': 'auto', 'ja': 'Japanese', 'en': 'English',
                'zh': 'Chinese', 'ko': 'Korean', 'vi': 'Vietnamese',
            };
            const sourceLang = sourceLangMap[settings.source_language] || 'Japanese';

            await invoke('start_local_pipeline', {
                sourceLang: sourceLang,
                targetLang: settings.target_language || 'vi',
                channel: this.localPipelineChannel,
            });
            console.log('[App] Local pipeline spawned');
        } catch (err) {
            console.error('Failed to start pipeline:', err);
            this._showToast(`Pipeline error: ${err}`, 'error');
            throw err;
        }
    },


    _handleLocalPipelineResult(data) {
        switch (data.type) {
            case 'ready':
                this.localPipelineReady = true;
                this._updateStatus('connected');
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.showListening();
                this._showToast('Local models ready!', 'success');
                break;
            case 'result':
                if (data.original) {
                    this._commitSourceTurn(data.original, null, settingsManager.get().source_language);
                }
                break;
            case 'status':
                const msg = data.message || 'Loading...';
                // Status bar: show compact message (strip [pipeline] prefix)
                const statusText = document.getElementById('status-text');
                if (statusText) {
                    const compact = msg.replace(/^\[pipeline\]\s*/, '');
                    statusText.textContent = compact;
                }
                // Transcript area: only show loading/starting messages, not debug logs
                if (!msg.startsWith('[pipeline]')) {
                    this.transcriptUI.showStatusMessage(msg);
                }
                break;
            case 'done':
                this._updateStatus('disconnected');
                break;
        }
    },


    async _runMlxSetup() {
        const modal = document.getElementById('setup-modal');
        const progressFill = document.getElementById('setup-progress-fill');
        const progressPct = document.getElementById('setup-progress-pct');
        const statusText = document.getElementById('setup-status-text');
        const cancelBtn = document.getElementById('btn-cancel-setup');

        // Step mapping: step name → total progress weight
        const stepWeights = { check: 5, venv: 10, packages: 35, models: 50 };
        let totalProgress = 0;

        const updateStep = (stepName, icon, isActive) => {
            const stepEl = document.getElementById(`step-${stepName}`);
            if (!stepEl) return;
            stepEl.querySelector('.step-icon').textContent = icon;
            stepEl.classList.toggle('active', isActive);
            stepEl.classList.toggle('done', icon === '✅');
        };

        const updateProgress = (pct) => {
            totalProgress = Math.min(100, pct);
            progressFill.style.width = totalProgress + '%';
            progressPct.textContent = Math.round(totalProgress) + '%';
        };

        // Show modal
        modal.style.display = 'flex';

        return new Promise((resolve, reject) => {
            const channel = new window.__TAURI__.core.Channel();

            // Cancel handler
            const onCancel = () => {
                modal.style.display = 'none';
                reject(new Error('Setup cancelled'));
            };
            cancelBtn.addEventListener('click', onCancel, { once: true });

            channel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    return;
                }

                switch (data.type) {
                    case 'progress':
                        statusText.textContent = data.message || 'Working...';

                        // Update step indicators
                        if (data.step) {
                            // Mark previous steps as done
                            const steps = ['check', 'venv', 'packages', 'models'];
                            const currentIdx = steps.indexOf(data.step);
                            steps.forEach((s, i) => {
                                if (i < currentIdx) updateStep(s, '✅', false);
                                else if (i === currentIdx) updateStep(s, '🔄', true);
                            });

                            if (data.done) {
                                updateStep(data.step, '✅', false);
                            }

                            // Calculate overall progress
                            let pct = 0;
                            steps.forEach((s, i) => {
                                if (i < currentIdx) pct += stepWeights[s];
                                else if (i === currentIdx) {
                                    pct += (data.progress || 0) / 100 * stepWeights[s];
                                }
                            });
                            updateProgress(pct);
                        }
                        break;

                    case 'complete':
                        updateProgress(100);
                        statusText.textContent = '✅ ' + (data.message || 'Setup complete!');
                        ['check', 'venv', 'packages', 'models'].forEach(s => updateStep(s, '✅', false));

                        // Close modal after brief delay
                        setTimeout(() => {
                            modal.style.display = 'none';
                            resolve();
                        }, 1000);
                        break;

                    case 'error':
                        statusText.textContent = '❌ ' + (data.message || 'Setup failed');
                        cancelBtn.textContent = 'Close';
                        cancelBtn.removeEventListener('click', onCancel);
                        cancelBtn.addEventListener('click', () => {
                            modal.style.display = 'none';
                            reject(new Error(data.message));
                        }, { once: true });
                        break;

                    case 'log':
                        console.log('[MLX Setup]', data.message);
                        break;
                }
            };

            invoke('run_mlx_setup', { channel })
                .catch(err => {
                    statusText.textContent = '❌ ' + err;
                    modal.style.display = 'none';
                    reject(err);
                });
        });
    }

};
