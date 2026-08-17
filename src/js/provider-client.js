/** Shared PCM buffering + Tauri invoke for Groq/Cloudflare clients. */

const MIN_PCM_BYTES = 32000; // ~1s of 16 kHz s16le mono
/** RMS below this ≈ silence / near-silence (16-bit PCM). */
const SILENCE_RMS_THRESHOLD = 280;

/** Common Whisper hallucinations on silence / noise (exact-ish short phrases). */
const STT_HALLUCINATION_RE = [
    /^thank(s| you)([.!?\s]*)$/i,
    /^thanks for watching([.!?\s]*)$/i,
    /^thank you for watching([.!?\s]*)$/i,
    /^please subscribe([.!?\s]*)$/i,
    /^subscribe([.!?\s]*)$/i,
    /^see you (next time|later)([.!?\s]*)$/i,
    /^(uh+|um+|ah+|hmm+)([.!?\s]*)$/i,
    /^\.+$/,
    /^…+$/,
];

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
        llmModel: config.llmModel || config.groqLlmModel || '',
        llmProvider: config.llmProvider || 'automatic',
    };
}

/** RMS of s16le mono PCM (Uint8Array). */
export function pcmRms(pcm) {
    if (!pcm || pcm.byteLength < 2) return 0;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const n = Math.floor(pcm.byteLength / 2);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const s = view.getInt16(i * 2, true);
        sum += s * s;
    }
    return Math.sqrt(sum / n);
}

/** True when the buffer is silence / near-silence (skip STT). */
export function isPcmSilent(pcm, threshold = SILENCE_RMS_THRESHOLD) {
    return pcmRms(pcm) < threshold;
}

/** True for known Whisper silence-hallucination phrases. */
export function isSttHallucination(text) {
    const t = (text || '').trim();
    if (!t) return true;
    if (t.length <= 2) return true;
    return STT_HALLUCINATION_RE.some((re) => re.test(t));
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
