import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssemblyAIClient } from '../src/js/assemblyai-client.js';
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
    }
    close(code = 1000) {
        this.readyState = 3;
        this.onclose?.({ code });
    }
}

function makeClient() {
    FakeWebSocket.instances = [];
    setProviderInvoke(async (cmd) => {
        assert.equal(cmd, 'assemblyai_streaming_token');
        return { token: 'tmp_token' };
    });
    return new AssemblyAIClient({ WebSocketImpl: FakeWebSocket });
}

test('AssemblyAI partial Turn updates provisional text only', async () => {
    const client = makeClient();
    const events = [];
    client.onProvisional = (t) => events.push(['prov', t]);
    client.onOriginal = (t) => events.push(['orig', t]);
    await client.connect({ region: 'eu', model: 'universal-streaming-english' });
    const ws = FakeWebSocket.instances[0];
    assert.match(ws.url, /streaming\.eu\.assemblyai\.com\/v3\/ws/);
    assert.match(ws.url, /token=tmp_token/);
    assert.equal(ws.url.includes('aai_live'), false);
    ws.onmessage({ data: JSON.stringify({ type: 'Begin' }) });
    ws.onmessage({ data: JSON.stringify({ type: 'Turn', transcript: 'hello there', end_of_turn: false }) });
    assert.deepEqual(events, [['prov', 'hello there']]);
});

test('AssemblyAI final Turn commits one source segment', async () => {
    const client = makeClient();
    const events = [];
    client.onProvisional = (t) => events.push(['prov', t]);
    client.onOriginal = (t) => events.push(['orig', t]);
    await client.connect({ region: 'eu' });
    const ws = FakeWebSocket.instances[0];
    ws.onmessage({ data: JSON.stringify({ type: 'Turn', transcript: 'hello there', end_of_turn: true, language_code: 'en' }) });
    assert.deepEqual(events, [
        ['prov', ''],
        ['orig', 'hello there'],
    ]);
});

test('Terminate is sent on disconnect and connection is closed', async () => {
    const client = makeClient();
    await client.connect({ region: 'us' });
    const ws = FakeWebSocket.instances[0];
    const done = client.disconnect();
    await done;
    const terminate = ws.sent.find((item) => typeof item === 'string' && item.includes('Terminate'));
    assert.ok(terminate);
    assert.equal(client.isConnected, false);
});

test('endpoint_delay maps to AssemblyAI turn silence query params', async () => {
    const { turnSilenceFromEndpointDelay } = await import('../src/js/assemblyai-client.js');
    assert.deepEqual(turnSilenceFromEndpointDelay(800), {
        min_end_of_turn_silence_when_confident: '800',
        max_turn_silence: '1600',
    });
    const client = makeClient();
    await client.connect({ region: 'eu', endpointDelayMs: 1200 });
    const ws = FakeWebSocket.instances[0];
    assert.match(ws.url, /min_end_of_turn_silence_when_confident=1200/);
    assert.match(ws.url, /max_turn_silence=2000/);
});

test('failed start does not leave a socket billing', async () => {
    setProviderInvoke(async () => {
        throw new Error('HTTP 401');
    });
    const client = new AssemblyAIClient({ WebSocketImpl: FakeWebSocket });
    let fallbacks = 0;
    client.onFallback = () => { fallbacks += 1; };
    FakeWebSocket.instances = [];
    await client.connect({ region: 'eu' });
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(client.isConnected, false);
    assert.equal(fallbacks, 1);
});

test('PCM is sent as binary frames', async () => {
    const client = makeClient();
    await client.connect({ region: 'eu' });
    const ws = FakeWebSocket.instances[0];
    const pcm = new Uint8Array([1, 2, 3, 4]);
    client.sendAudio(pcm);
    assert.ok(ws.sent.some((item) => item instanceof Uint8Array || item instanceof ArrayBuffer));
});
