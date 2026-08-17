/**
 * Speechmatics Realtime STT — JWT via Tauri, PCM over WebSocket.
 * Optional in-session translation via translation_config on the same socket.
 * @see https://docs.speechmatics.com/speech-to-text/realtime/quickstart
 */

import { getProviderInvoke } from './provider-client.js';
import { parseProviderError, createProviderError, ERROR_TYPES } from './provider-orchestrator.js';

export const SPEECHMATICS_RT_URL = 'wss://eu.rt.speechmatics.com/v2';
const CONNECT_TIMEOUT_MS = 8000;
const END_WAIT_MS = 1500;

const LANG_ALIASES = {
    zh: 'cmn',
    'zh-cn': 'cmn',
    'zh-tw': 'cmn',
    'pt-br': 'pt',
};

export function mapSpeechmaticsLanguage(code, { allowAuto = true } = {}) {
    const raw = String(code || '').trim().toLowerCase();
    if (!raw || raw === 'auto') return allowAuto ? 'en' : '';
    return LANG_ALIASES[raw] || raw.split('-')[0];
}

export function extractTranscript(msg) {
    const meta = msg?.metadata?.transcript;
    if (typeof meta === 'string' && meta.trim()) return meta.trim();
    if (!Array.isArray(msg?.results)) return '';
    return msg.results
        .map((r) => r?.alternatives?.[0]?.content || r?.content || '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s+([.,!?;:])/g, '$1')
        .trim();
}

export function extractTranslation(msg) {
    if (!Array.isArray(msg?.results)) return '';
    return msg.results.map((r) => r?.content || '').filter(Boolean).join(' ').trim();
}

export function extractSpeaker(msg) {
    const fromResults = msg?.results?.[0]?.alternatives?.[0]?.speaker
        || msg?.results?.[0]?.speaker;
    return fromResults || null;
}

export function buildStartRecognition(config = {}) {
    const model = config.model === 'standard' ? 'standard' : 'enhanced';
    const start = {
        message: 'StartRecognition',
        audio_format: {
            type: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: 16000,
        },
        transcription_config: {
            language: mapSpeechmaticsLanguage(config.sourceLanguage),
            model,
            max_delay: 0.7,
            max_delay_mode: 'flexible',
            enable_partials: true,
        },
    };
    if (config.enableTranslation) {
        const target = mapSpeechmaticsLanguage(config.targetLanguage, { allowAuto: false });
        if (target) {
            start.translation_config = {
                target_languages: [target],
                enable_partials: true,
            };
        }
    }
    return start;
}

export class SpeechmaticsClient {
    constructor(options = {}) {
        this.isConnected = false;
        this.providerId = 'speechmatics';
        this._config = null;
        this._intentionalDisconnect = false;
        this._generation = 0;
        this._ws = null;
        this._seqNo = 0;
        this._WebSocketImpl = options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
        this._connectTimer = null;
        this._endTimer = null;
        this._pendingStart = null;
        this._pendingEnd = null;

        this.onOriginal = null;
        this.onTranslation = null;
        this.onTranslationPartial = null;
        this.onProvisional = null;
        this.onSegment = null;
        this.onStatusChange = null;
        this.onError = null;
        this.onFallback = null;
        this.onBegin = null;
        this.onTerminated = null;
    }

    async connect(config = {}) {
        this._config = {
            model: config.model || config.speechmaticsModel || 'enhanced',
            sourceLanguage: config.sourceLanguage || config.sourceLang || 'auto',
            targetLanguage: config.targetLanguage || config.targetLang || 'vi',
            enableTranslation: !!config.enableTranslation,
        };
        this._intentionalDisconnect = false;
        this._generation += 1;
        this._seqNo = 0;
        const gen = this._generation;
        this._setStatus('connecting');

        try {
            const invoke = getProviderInvoke();
            const minted = await invoke('speechmatics_rt_token', { ttl: 3600 });
            if (gen !== this._generation) return;
            const token = minted?.token || minted;
            if (!token || typeof token !== 'string') {
                throw createProviderError({
                    provider: 'speechmatics',
                    capability: 'stt',
                    kind: ERROR_TYPES.CONFIG,
                    status: 401,
                    message: 'Speechmatics token mint failed',
                });
            }
            await this._openSocket(token, gen);
        } catch (err) {
            if (gen !== this._generation || this._intentionalDisconnect) return;
            this.isConnected = false;
            this._setStatus('error');
            const parsed = parseProviderError(err, { provider: 'speechmatics', capability: 'stt' });
            this.onError?.(parsed);
            if (!this._intentionalDisconnect) this.onFallback?.(parsed);
        }
    }

    _openSocket(token, gen) {
        const WS = this._WebSocketImpl;
        if (!WS) {
            throw createProviderError({
                provider: 'speechmatics',
                capability: 'stt',
                kind: ERROR_TYPES.UNSUPPORTED,
                message: 'WebSocket is unavailable',
            });
        }
        const lang = mapSpeechmaticsLanguage(this._config.sourceLanguage);
        const url = `${SPEECHMATICS_RT_URL}/${lang}?jwt=${encodeURIComponent(token)}`;
        return new Promise((resolve, reject) => {
            const ws = new WS(url);
            this._ws = ws;
            this._pendingStart = { resolve, reject, gen };
            this._connectTimer = setTimeout(() => {
                reject(createProviderError({
                    provider: 'speechmatics',
                    capability: 'stt',
                    kind: ERROR_TYPES.TEMPORARY,
                    status: 408,
                    message: 'Speechmatics connection timed out',
                }));
                try { ws.close(); } catch { /* ignore */ }
            }, CONNECT_TIMEOUT_MS);

            ws.binaryType = 'arraybuffer';
            ws.onopen = () => {
                if (gen !== this._generation) {
                    try { ws.close(); } catch { /* ignore */ }
                    return;
                }
                try {
                    ws.send(JSON.stringify(buildStartRecognition(this._config)));
                } catch (err) {
                    if (this._connectTimer) clearTimeout(this._connectTimer);
                    this._pendingStart = null;
                    reject(parseProviderError(err, { provider: 'speechmatics', capability: 'stt' }));
                }
            };
            ws.onmessage = (event) => {
                if (gen !== this._generation) return;
                this._handleMessage(event.data);
            };
            ws.onerror = () => {
                /* close handler reports the failure */
            };
            ws.onclose = (event) => {
                if (this._connectTimer) clearTimeout(this._connectTimer);
                this.isConnected = false;
                if (this._pendingEnd) {
                    this._pendingEnd();
                    this._pendingEnd = null;
                }
                if (this._pendingStart && this._pendingStart.gen === gen) {
                    const pending = this._pendingStart;
                    this._pendingStart = null;
                    pending.reject(createProviderError({
                        provider: 'speechmatics',
                        capability: 'stt',
                        kind: event?.code === 1008 ? ERROR_TYPES.CONFIG : ERROR_TYPES.TEMPORARY,
                        closeCode: event?.code,
                        message: 'Speechmatics connection closed before RecognitionStarted',
                    }));
                    return;
                }
                if (this._intentionalDisconnect || gen !== this._generation) return;
                const parsed = createProviderError({
                    provider: 'speechmatics',
                    capability: 'stt',
                    kind: ERROR_TYPES.TEMPORARY,
                    closeCode: event?.code,
                    message: 'Speechmatics connection closed',
                });
                this.onError?.(parsed);
                this.onFallback?.(parsed);
            };
        });
    }

    _handleMessage(data) {
        if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
            if (typeof Blob !== 'undefined' && data instanceof Blob) {
                data.text().then((text) => this._handleJson(text)).catch(() => {});
                return;
            }
        }
        const text = typeof data === 'string' ? data : null;
        if (!text) return;
        this._handleJson(text);
    }

    _handleJson(text) {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }
        const type = msg.message || msg.message_type;
        if (type === 'RecognitionStarted') {
            if (this._connectTimer) clearTimeout(this._connectTimer);
            this.isConnected = true;
            this._setStatus('connected');
            this.onBegin?.(msg);
            if (this._pendingStart) {
                this._pendingStart.resolve();
                this._pendingStart = null;
            }
            return;
        }
        if (type === 'Error') {
            const parsed = createProviderError({
                provider: 'speechmatics',
                capability: 'stt',
                kind: ERROR_TYPES.CONFIG,
                message: msg.reason || msg.type || 'Speechmatics error',
            });
            if (this._pendingStart) {
                if (this._connectTimer) clearTimeout(this._connectTimer);
                this._pendingStart.reject(parsed);
                this._pendingStart = null;
                return;
            }
            this.onError?.(parsed);
            if (!this._intentionalDisconnect) this.onFallback?.(parsed);
            return;
        }
        if (type === 'EndOfTranscript') {
            this.onTerminated?.(msg);
            if (this._pendingEnd) {
                this._pendingEnd();
                this._pendingEnd = null;
            }
            return;
        }
        if (type === 'AddPartialTranscript') {
            const transcript = extractTranscript(msg);
            const speaker = extractSpeaker(msg);
            const language = msg.metadata?.language || this._config.sourceLanguage;
            if (transcript) this.onProvisional?.(transcript, speaker, language);
            return;
        }
        if (type === 'AddTranscript') {
            const transcript = extractTranscript(msg);
            const speaker = extractSpeaker(msg);
            const language = msg.metadata?.language || this._config.sourceLanguage;
            if (transcript) this.onOriginal?.(transcript, speaker, language);
            return;
        }
        if (type === 'AddPartialTranslation') {
            const translated = extractTranslation(msg);
            if (translated) this.onTranslationPartial?.(translated, msg.language);
            return;
        }
        if (type === 'AddTranslation') {
            const translated = extractTranslation(msg);
            if (translated) this.onTranslation?.(translated, msg.language);
        }
    }

    sendAudio(arrayBuffer) {
        if (!this.isConnected || !this._ws || this._ws.readyState !== 1) return;
        const bytes = arrayBuffer instanceof Uint8Array
            ? arrayBuffer
            : new Uint8Array(arrayBuffer);
        if (!bytes.byteLength) return;
        try {
            this._ws.send(bytes);
            this._seqNo += 1;
        } catch {
            /* ignore send on closing socket */
        }
    }

    async disconnect() {
        this._intentionalDisconnect = true;
        this.isConnected = false;
        await this._endAndClose();
        this._generation += 1;
        this._setStatus('disconnected');
    }

    async _endAndClose() {
        const ws = this._ws;
        this._ws = null;
        if (!ws) return;
        try {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this._seqNo }));
                await Promise.race([
                    new Promise((resolve) => { this._pendingEnd = resolve; }),
                    new Promise((resolve) => {
                        this._endTimer = setTimeout(resolve, END_WAIT_MS);
                    }),
                ]);
            }
        } catch {
            /* ignore */
        } finally {
            if (this._endTimer) clearTimeout(this._endTimer);
            this._pendingEnd = null;
            try { ws.close(); } catch { /* ignore */ }
        }
    }

    pause() {
        this._setStatus('paused');
    }

    resume() {
        if (this.isConnected) this._setStatus('connected');
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

export const speechmaticsClient = new SpeechmaticsClient();
