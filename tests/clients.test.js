import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroqClient } from '../src/js/groq-client.js';
import { CloudflareClient } from '../src/js/cloudflare-client.js';
import {
    setProviderInvoke,
    normalizeClientConfig,
    PcmBuffer,
    isPcmSilent,
    isSttHallucination,
} from '../src/js/provider-client.js';

/** Loud s16le PCM so silence gate does not skip the buffer. */
function loudPcm(bytes = 32000) {
    const u8 = new Uint8Array(bytes);
    const view = new DataView(u8.buffer);
    for (let i = 0; i < bytes / 2; i++) {
        view.setInt16(i * 2, 8000, true);
    }
    return u8;
}

test('normalizeClientConfig accepts sourceLang aliases', () => {
    const cfg = normalizeClientConfig({
        apiKey: 'k',
        sourceLang: 'ja',
        targetLang: 'vi',
        accountId: 'a',
        apiToken: 't',
    });
    assert.equal(cfg.sourceLanguage, 'ja');
    assert.equal(cfg.targetLanguage, 'vi');
});

test('silence and hallucination helpers', () => {
    assert.equal(isPcmSilent(new Uint8Array(32000)), true);
    assert.equal(isPcmSilent(loudPcm(32000)), false);
    assert.equal(isSttHallucination('Thank you.'), true);
    assert.equal(isSttHallucination('Thanks for watching!'), true);
    assert.equal(isSttHallucination('Hello everyone'), false);
});

test('Groq client invokes Rust with PCM and language contract', async () => {
    const calls = [];
    setProviderInvoke(async (cmd, args) => {
        calls.push({ cmd, args });
        return { source_text: 'hello' };
    });
    const client = new GroqClient();
    const events = [];
    client.onOriginal = (t) => events.push(['original', t]);
    client.onTranslation = (t) => events.push(['translation', t]);
    client.onSegment = (s, t) => events.push(['segment', s, t]);
    client.connect({
        apiKey: 'k',
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        sttModel: 'whisper-large-v3',
        llmModel: 'llama-3.3-70b-versatile',
    });
    assert.equal(client.isConnected, true);
    client._buffer.push(loudPcm(32000));
    await client._processAudioBuffer();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'groq_transcribe_only');
    assert.equal(calls[0].args.sourceLanguage, 'en');
    assert.equal(calls[0].args.pcm.length, 32000);
    assert.equal(calls[0].args.sttModel, 'whisper-large-v3');
    assert.deepEqual(events, [
        ['original', 'hello'],
    ]);
    assert.equal(typeof client._translateText, 'undefined');
});

test('Groq client skips silent buffers (no API call)', async () => {
    const calls = [];
    setProviderInvoke(async (cmd) => {
        calls.push(cmd);
        return { source_text: 'Thank you.', translated_text: 'Mulțumesc.' };
    });
    const client = new GroqClient();
    const events = [];
    client.onSegment = () => events.push('seg');
    client.connect({ apiKey: 'k', sourceLanguage: 'en', targetLanguage: 'ro' });
    client._buffer.push(new Uint8Array(32000));
    await client._processAudioBuffer();
    assert.equal(calls.length, 0);
    assert.equal(events.length, 0);
});

test('Groq client drops Thank you hallucination', async () => {
    setProviderInvoke(async () => ({
        source_text: 'Thank you.',
        translated_text: 'Mulțumesc.',
    }));
    const client = new GroqClient();
    const events = [];
    client.onSegment = () => events.push('seg');
    client.connect({ apiKey: 'k', sourceLanguage: 'en', targetLanguage: 'ro' });
    client._buffer.push(loudPcm(32000));
    await client._processAudioBuffer();
    assert.equal(events.length, 0);
});

test('Groq client fallback fires once on invoke failure', async () => {
    setProviderInvoke(async () => {
        throw new Error('provider down');
    });
    const client = new GroqClient();
    let errors = 0;
    let fallbacks = 0;
    client.onError = () => { errors += 1; };
    client.onFallback = () => { fallbacks += 1; };
    client.connect({ apiKey: 'k', sourceLanguage: 'en', targetLanguage: 'vi' });
    client._buffer.push(loudPcm(8));
    await client._processAudioBuffer();
    assert.equal(errors, 1);
    assert.equal(fallbacks, 1);
});

test('Cloudflare client invokes Rust command', async () => {
    const calls = [];
    setProviderInvoke(async (cmd, args) => {
        calls.push({ cmd, args });
        return { source_text: 'hi', translated_text: 'chao' };
    });
    const client = new CloudflareClient();
    client.connect({
        accountId: 'acct',
        apiToken: 'tok',
        sourceLanguage: 'en',
        targetLanguage: 'vi',
    });
    client._buffer.push(loudPcm(4));
    await client._processAudioBuffer();
    assert.equal(calls[0].cmd, 'cloudflare_transcribe_only');
    assert.equal(calls[0].args.accountId, 'acct');
    assert.equal(typeof client._translateText, 'undefined');
});

test('PCM buffer concatenates chunks', () => {
    const buf = new PcmBuffer(4);
    buf.push(new Uint8Array([1, 2]));
    buf.push(new Uint8Array([3, 4]));
    assert.equal(buf.ready(), true);
    assert.deepEqual(Array.from(buf.take()), [1, 2, 3, 4]);
    assert.equal(buf.byteLength, 0);
});
