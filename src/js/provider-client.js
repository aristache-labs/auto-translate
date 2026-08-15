/** Shared PCM buffering + Tauri invoke for Groq/Cloudflare clients. */

const MIN_PCM_BYTES = 32000; // ~1s of 16 kHz s16le mono

let invokeImpl = null;

export function setProviderInvoke(fn) {
    invokeImpl = fn;
}

export function getProviderInvoke() {
    if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
        return window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
    }
    if (invokeImpl) return invokeImpl;
    throw new Error('Tauri invoke is unavailable');
}

export function normalizeClientConfig(config = {}) {
    return {
        apiKey: config.apiKey || '',
        accountId: config.accountId || '',
        apiToken: config.apiToken || '',
        sourceLanguage: config.sourceLanguage || config.sourceLang || 'auto',
        targetLanguage: config.targetLanguage || config.targetLang || 'vi',
        sttModel: config.sttModel || config.groqSttModel || config.cloudflareSttModel || '',
        llmModel: config.llmModel || config.groqLlmModel || config.cloudflareLlmModel || '',
        llmProvider: config.llmProvider || 'engine',
        openrouterApiKey: config.openrouterApiKey || '',
        openrouterModel: config.openrouterModel || 'openai/gpt-4o-mini',
    };
}

export class PcmBuffer {
    constructor(minBytes = MIN_PCM_BYTES) {
        this.minBytes = minBytes;
        this._chunks = [];
        this._byteLength = 0;
    }

    push(arrayBuffer) {
        if (!arrayBuffer) return;
        const bytes = arrayBuffer instanceof Uint8Array
            ? arrayBuffer
            : new Uint8Array(arrayBuffer);
        this._chunks.push(bytes);
        this._byteLength += bytes.byteLength;
    }

    get byteLength() {
        return this._byteLength;
    }

    ready() {
        return this._byteLength >= this.minBytes;
    }

    take() {
        const out = new Uint8Array(this._byteLength);
        let offset = 0;
        for (const chunk of this._chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        this._chunks = [];
        this._byteLength = 0;
        return out;
    }

    clear() {
        this._chunks = [];
        this._byteLength = 0;
    }
}

export function pcmToNumberArray(pcm) {
    return Array.from(pcm);
}
