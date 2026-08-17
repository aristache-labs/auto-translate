import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SpeechmaticsClient,
    buildStartRecognition,
    extractTranscript,
    extractTranslation,
    mapSpeechmaticsLanguage,
} from '../src/js/speechmatics-client.js';
import { setProviderInvoke } from '../src/js/provider-client.js';

class FakeWebSocket {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.binaryType = 'arraybuffer';
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => {
            this.readyState = 1;
            this.onopen?.();
        });
    }
    send(data) {
        this.sent.push(data);
        if (typeof data === 'string' && data.includes('StartRecognition')) {
            queueMicrotask(() => {
                this.onmessage?.({ data: JSON.stringify({ message: 'RecognitionStarted' }) });
            });
        }
        if (typeof data === 'string' && data.includes('EndOfStream')) {
            queueMicrotask(() => {
                this.onmessage?.({ data: JSON.stringify({ message: 'EndOfTranscript' }) });
            });
        }
    }
    close(code = 1000) {
        this.readyState = 3;
        this.onclose?.({ code });
    }
}

function makeClient() {
    FakeWebSocket.instances = [];
    setProviderInvoke(async (cmd) => {
        assert.equal(cmd, 'speechmatics_rt_token');
        return { token: 'sm_jwt' };
    });
    return new SpeechmaticsClient({ WebSocketImpl: FakeWebSocket });
}

test('mapSpeechmaticsLanguage aliases zh and defaults auto to en', () => {
    assert.equal(mapSpeechmaticsLanguage('auto'), 'en');
    assert.equal(mapSpeechmaticsLanguage('zh'), 'cmn');
    assert.equal(mapSpeechmaticsLanguage('pt-BR'), 'pt');
    assert.equal(mapSpeechmaticsLanguage('auto', { allowAuto: false }), '');
    assert.equal(mapSpeechmaticsLanguage('vi'), 'vi');
});

test('buildStartRecognition includes translation_config when enabled', () => {
    const start = buildStartRecognition({
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        enableTranslation: true,
        model: 'enhanced',
    });
    assert.equal(start.message, 'StartRecognition');
    assert.equal(start.audio_format.encoding, 'pcm_s16le');
    assert.equal(start.audio_format.sample_rate, 16000);
    assert.equal(start.transcription_config.language, 'en');
    assert.equal(start.transcription_config.enable_partials, true);
    assert.deepEqual(start.translation_config.target_languages, ['vi']);
    assert.equal(start.translation_config.enable_partials, true);
});

test('buildStartRecognition omits translation when disabled', () => {
    const start = buildStartRecognition({ sourceLanguage: 'en', enableTranslation: false });
    assert.equal(start.translation_config, undefined);
});

test('connect mints JWT, starts session, and maps partials/finals', async () => {
    const client = makeClient();
    const events = [];
    client.onProvisional = (t) => events.push(['prov', t]);
    client.onOriginal = (t) => events.push(['orig', t]);
    await client.connect({ sourceLanguage: 'en', enableTranslation: true, targetLanguage: 'es' });
    const ws = FakeWebSocket.instances[0];
    assert.match(ws.url, /eu\.rt\.speechmatics\.com\/v2\/en/);
    assert.match(ws.url, /jwt=sm_jwt/);
    const start = JSON.parse(ws.sent.find((item) => typeof item === 'string' && item.includes('StartRecognition')));
    assert.deepEqual(start.translation_config.target_languages, ['es']);
    assert.equal(client.isConnected, true);

    ws.onmessage({
        data: JSON.stringify({
            message: 'AddPartialTranscript',
            metadata: { transcript: 'Hello' },
        }),
    });
    ws.onmessage({
        data: JSON.stringify({
            message: 'AddTranscript',
            metadata: { transcript: 'Hello, welcome.' },
        }),
    });
    assert.deepEqual(events, [
        ['prov', 'Hello'],
        ['orig', 'Hello, welcome.'],
    ]);
});

test('AddTranslation / AddPartialTranslation fire translation callbacks', async () => {
    const client = makeClient();
    const events = [];
    client.onTranslationPartial = (t, lang) => events.push(['part', t, lang]);
    client.onTranslation = (t, lang) => events.push(['final', t, lang]);
    await client.connect({ enableTranslation: true, targetLanguage: 'es' });
    const ws = FakeWebSocket.instances[0];
    ws.onmessage({
        data: JSON.stringify({
            message: 'AddPartialTranslation',
            language: 'es',
            results: [{ content: 'Bienvenidos a' }],
        }),
    });
    ws.onmessage({
        data: JSON.stringify({
            message: 'AddTranslation',
            language: 'es',
            results: [{ content: 'Bienvenidos a Speechmatics.' }],
        }),
    });
    assert.deepEqual(events, [
        ['part', 'Bienvenidos a', 'es'],
        ['final', 'Bienvenidos a Speechmatics.', 'es'],
    ]);
});

test('disconnect sends EndOfStream with last_seq_no', async () => {
    const client = makeClient();
    await client.connect({ sourceLanguage: 'en' });
    const ws = FakeWebSocket.instances[0];
    client.sendAudio(new Uint8Array([1, 2, 3, 4]));
    await client.disconnect();
    const end = ws.sent.find((item) => typeof item === 'string' && item.includes('EndOfStream'));
    assert.ok(end);
    assert.equal(JSON.parse(end).last_seq_no, 1);
    assert.equal(client.isConnected, false);
});

test('extractTranscript prefers metadata then results', () => {
    assert.equal(extractTranscript({ metadata: { transcript: 'Hi there' } }), 'Hi there');
    assert.equal(extractTranslation({
        results: [{ content: 'Hola' }, { content: 'mundo' }],
    }), 'Hola mundo');
});
