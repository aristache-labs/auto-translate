/**
 * AssemblyAI Streaming v3 client — temporary token via Tauri, PCM over WebSocket.
 */

import { getProviderInvoke } from './provider-client.js';
import { parseProviderError, createProviderError, ERROR_TYPES } from './provider-orchestrator.js';

export const ASSEMBLYAI_ENDPOINTS = {
    eu: 'wss://streaming.eu.assemblyai.com/v3/ws',
    us: 'wss://streaming.us.assemblyai.com/v3/ws',
    global: 'wss://streaming.assemblyai.com/v3/ws',
    edge: 'wss://streaming.assemblyai.com/v3/ws',
};

const TERMINATE_WAIT_MS = 1500;
const CONNECT_TIMEOUT_MS = 8000;

function endpointForRegion(region) {
    const key = String(region || 'eu').toLowerCase();
    return ASSEMBLYAI_ENDPOINTS[key] || ASSEMBLYAI_ENDPOINTS.eu;
}

function extractTurnText(msg) {
    if (!msg || typeof msg !== 'object') return '';
    if (typeof msg.transcript === 'string') return msg.transcript;
    if (typeof msg.text === 'string') return msg.text;
    if (Array.isArray(msg.words)) {
        return msg.words.map((w) => w.text || w.word || '').filter(Boolean).join(' ');
    }
    return '';
}

export class AssemblyAIClient {
    constructor(options = {}) {
        this.isConnected = false;
        this.providerId = 'assemblyai';
        this._config = null;
        this._intentionalDisconnect = false;
        this._generation = 0;
        this._ws = null;
        this._WebSocketImpl = options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
        this._terminateTimer = null;
        this._connectTimer = null;
        this._pendingTerminate = null;

        this.onOriginal = null;
        this.onTranslation = null;
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
            region: config.region || config.assemblyaiRegion || 'eu',
            model: config.model || config.assemblyaiModel || 'universal-streaming-english',
            speakerLabels: !!(config.speakerLabels ?? config.assemblyaiSpeakerLabels),
            sourceLanguage: config.sourceLanguage || config.sourceLang || 'auto',
        };
        this._intentionalDisconnect = false;
        this._generation += 1;
        const gen = this._generation;
        this._setStatus('connecting');

        try {
            const invoke = getProviderInvoke();
            const minted = await invoke('assemblyai_streaming_token', {
                region: this._config.region,
            });
            if (gen !== this._generation) return;
            const token = minted?.token || minted;
            if (!token || typeof token !== 'string') {
                throw createProviderError({
                    provider: 'assemblyai',
                    capability: 'stt',
                    kind: ERROR_TYPES.CONFIG,
                    status: 401,
                    message: 'AssemblyAI token mint failed',
                });
            }
            await this._openSocket(token, gen);
        } catch (err) {
            if (gen !== this._generation || this._intentionalDisconnect) return;
            this.isConnected = false;
            this._setStatus('error');
            const parsed = parseProviderError(err, { provider: 'assemblyai', capability: 'stt' });
            this.onError?.(parsed);
            if (!this._intentionalDisconnect) this.onFallback?.(parsed);
        }
    }

    _openSocket(token, gen) {
        const WS = this._WebSocketImpl;
        if (!WS) {
            throw createProviderError({
                provider: 'assemblyai',
                capability: 'stt',
                kind: ERROR_TYPES.UNSUPPORTED,
                message: 'WebSocket is unavailable',
            });
        }
        const params = new URLSearchParams({
            sample_rate: '16000',
            token,
            speech_model: this._config.model,
            format_turns: 'true',
        });
        if (this._config.speakerLabels) params.set('speaker_labels', 'true');
        const url = `${endpointForRegion(this._config.region)}?${params.toString()}`;
        return new Promise((resolve, reject) => {
            const ws = new WS(url);
            this._ws = ws;
            this._connectTimer = setTimeout(() => {
                reject(createProviderError({
                    provider: 'assemblyai',
                    capability: 'stt',
                    kind: ERROR_TYPES.TEMPORARY,
                    status: 408,
                    message: 'AssemblyAI connection timed out',
                }));
                try { ws.close(); } catch { /* ignore */ }
            }, CONNECT_TIMEOUT_MS);

            ws.binaryType = 'arraybuffer';
            ws.onopen = () => {
                if (this._connectTimer) clearTimeout(this._connectTimer);
                if (gen !== this._generation) {
                    try { ws.close(); } catch { /* ignore */ }
                    return;
                }
                this.isConnected = true;
                this._setStatus('connected');
                resolve();
            };
            ws.onmessage = (event) => {
                if (gen !== this._generation) return;
                this._handleMessage(event.data);
            };
            ws.onerror = () => {
                if (this._connectTimer) clearTimeout(this._connectTimer);
            };
            ws.onclose = (event) => {
                if (this._connectTimer) clearTimeout(this._connectTimer);
                this.isConnected = false;
                if (this._pendingTerminate) {
                    this._pendingTerminate();
                    this._pendingTerminate = null;
                }
                if (this._intentionalDisconnect || gen !== this._generation) return;
                const code = event?.code;
                const parsed = createProviderError({
                    provider: 'assemblyai',
                    capability: 'stt',
                    kind: code === 4001 || code === 4008 ? ERROR_TYPES.CONFIG : ERROR_TYPES.TEMPORARY,
                    closeCode: code,
                    message: 'AssemblyAI connection closed',
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
        const type = msg.type || msg.message_type;
        if (type === 'Begin') {
            this.onBegin?.(msg);
            return;
        }
        if (type === 'SpeechStarted') return;
        if (type === 'Termination') {
            this.onTerminated?.(msg);
            if (this._pendingTerminate) {
                this._pendingTerminate();
                this._pendingTerminate = null;
            }
            return;
        }
        if (type === 'Turn' || msg.end_of_turn !== undefined) {
            const transcript = extractTurnText(msg).trim();
            const speaker = this._config.speakerLabels
                ? (msg.speaker_label || msg.speaker || null)
                : null;
            const language = msg.language_code || this._config.sourceLanguage;
            if (msg.end_of_turn) {
                this.onProvisional?.('', speaker, language);
                if (transcript) this.onOriginal?.(transcript, speaker, language);
            } else if (transcript) {
                this.onProvisional?.(transcript, speaker, language);
            }
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
        } catch {
            /* ignore send on closing socket */
        }
    }

    async disconnect() {
        this._intentionalDisconnect = true;
        this._generation += 1;
        this.isConnected = false;
        await this._terminateAndClose();
        this._setStatus('disconnected');
    }

    async _terminateAndClose() {
        const ws = this._ws;
        this._ws = null;
        if (!ws) return;
        try {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'Terminate' }));
                await Promise.race([
                    new Promise((resolve) => { this._pendingTerminate = resolve; }),
                    new Promise((resolve) => {
                        this._terminateTimer = setTimeout(resolve, TERMINATE_WAIT_MS);
                    }),
                ]);
            }
        } catch {
            /* ignore */
        } finally {
            if (this._terminateTimer) clearTimeout(this._terminateTimer);
            this._pendingTerminate = null;
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

export const assemblyaiClient = new AssemblyAIClient();
