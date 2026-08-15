/**
 * Groq client — buffers PCM and invokes Rust STT+translate.
 */

import {
    PcmBuffer,
    getProviderInvoke,
    normalizeClientConfig,
    pcmToNumberArray,
} from './provider-client.js';

export class GroqClient {
    constructor() {
        this.isConnected = false;
        this._config = null;
        this._intentionalDisconnect = false;
        this._buffer = new PcmBuffer();
        this._isProcessing = false;

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
        this._buffer.clear();

        if (!this._config.apiKey) {
            this._setStatus('error');
            this.onError?.('Groq API key is required. Please add it in Settings.');
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
        const pcm = this._buffer.take();
        try {
            const invoke = getProviderInvoke();
            const result = await invoke('groq_transcribe_and_translate', {
                pcm: pcmToNumberArray(pcm),
                sourceLanguage: this._config.sourceLanguage,
                targetLanguage: this._config.targetLanguage,
                apiKey: this._config.apiKey,
                sttModel: this._config.sttModel || this._config.groqSttModel || '',
                llmModel: this._config.llmModel || this._config.groqLlmModel || '',
                llmProvider: this._config.llmProvider || 'engine',
                openrouterApiKey: this._config.openrouterApiKey || '',
                openrouterModel: this._config.openrouterModel || '',
            });
            this._emitResult(result);
        } catch (err) {
            const message = err?.message || String(err);
            this.onError?.(message);
            if (!this._intentionalDisconnect) {
                this.onFallback?.(message);
            }
        } finally {
            this._isProcessing = false;
        }
    }

    _emitResult(result) {
        const source = (result?.source_text || result?.sourceText || '').trim();
        const translated = (result?.translated_text || result?.translatedText || '').trim();
        if (!source && !translated) return;
        if (source) {
            this.onProvisional?.(source, null, this._config.sourceLanguage);
            this.onOriginal?.(source, null, this._config.sourceLanguage);
        }
        if (translated) {
            this.onTranslation?.(translated);
        }
        this.onSegment?.(source, translated || source);
    }

    flushPending() {
        if (this._buffer.byteLength > 0) {
            this._processAudioBuffer();
        }
    }

    async disconnect() {
        this._intentionalDisconnect = true;
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
