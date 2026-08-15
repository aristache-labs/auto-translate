/**
 * Groq STT client — buffers PCM and invokes Rust transcription only.
 */

import {
    PcmBuffer,
    getProviderInvoke,
    normalizeClientConfig,
    pcmToNumberArray,
    isPcmSilent,
    isSttHallucination,
} from './provider-client.js';
import { parseProviderError } from './provider-orchestrator.js';

export class GroqClient {
    constructor() {
        this.isConnected = false;
        this._config = null;
        this._intentionalDisconnect = false;
        this._buffer = new PcmBuffer();
        this._isProcessing = false;
        this._generation = 0;
        this.providerId = 'groq';

        this.onOriginal = null;
        this.onTranslation = null;
        this.onProvisional = null;
        this.onSegment = null;
        this.onStatusChange = null;
        this.onError = null;
        this.onFallback = null;
    }

    connect(config) {
        this._config = normalizeClientConfig(config);
        this._intentionalDisconnect = false;
        this._generation += 1;
        this._buffer.clear();

        if (!this._config.apiKey) {
            this._setStatus('error');
            this.onError?.(parseProviderError('Groq API key is required. Please add it in Settings.', {
                provider: 'groq',
                capability: 'stt',
                status: 401,
            }));
            return;
        }

        this.isConnected = true;
        this._setStatus('connected');
    }

    sendAudio(arrayBuffer) {
        if (!this.isConnected) return;
        this._buffer.push(arrayBuffer);
        if (this._buffer.ready() && !this._isProcessing) {
            this._processAudioBuffer();
        }
    }

    async _processAudioBuffer() {
        if (this._isProcessing || this._buffer.byteLength === 0) return;
        this._isProcessing = true;
        const gen = this._generation;
        const pcm = this._buffer.take();
        try {
            if (isPcmSilent(pcm)) return;
            const invoke = getProviderInvoke();
            const result = await invoke('groq_transcribe_only', {
                pcm: pcmToNumberArray(pcm),
                sourceLanguage: this._config.sourceLanguage,
                apiKey: this._config.apiKey,
                sttModel: this._config.sttModel || this._config.groqSttModel || '',
            });
            if (gen !== this._generation || this._intentionalDisconnect) return;
            this._emitResult(result);
        } catch (err) {
            if (gen !== this._generation || this._intentionalDisconnect) return;
            const parsed = parseProviderError(err, { provider: 'groq', capability: 'stt' });
            this.onError?.(parsed);
            if (!this._intentionalDisconnect) this.onFallback?.(parsed);
        } finally {
            this._isProcessing = false;
            if (this.isConnected && this._buffer.ready()) {
                void this._processAudioBuffer();
            }
        }
    }

    _emitResult(result) {
        const source = (result?.source_text || result?.sourceText || '').trim();
        if (isSttHallucination(source) || !source) return;
        this.onProvisional?.(source, null, this._config.sourceLanguage);
        this.onOriginal?.(source, null, this._config.sourceLanguage);
    }

    flushPending() {
        if (this._buffer.byteLength > 0) {
            this._processAudioBuffer();
        }
    }

    async disconnect() {
        this._intentionalDisconnect = true;
        this._generation += 1;
        this.isConnected = false;
        this.flushPending();
        this._setStatus('disconnected');
    }

    pause() {
        this._setStatus('paused');
    }

    resume() {
        if (this._config?.apiKey) {
            this.isConnected = true;
            this._setStatus('connected');
        }
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

export const groqClient = new GroqClient();
