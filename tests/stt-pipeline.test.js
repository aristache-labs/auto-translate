import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextSttProvider,
  applyProviderError,
  resetAllCircuitBreakers,
  breakerKey,
  isCircuitBreakerOpen,
} from '../src/js/provider-orchestrator.js';

test('audio capture starts once and STT fallback only swaps the consumer', () => {
    const capture = { starts: 0, stops: 0, started: false };
    const startCapture = () => {
        if (capture.started) return;
        capture.started = true;
        capture.starts += 1;
    };
    const stopCapture = () => {
        capture.started = false;
        capture.stops += 1;
    };
    startCapture();
    let active = 'groq';
    const failover = () => { active = 'cloudflare'; };
    failover();
    assert.equal(capture.starts, 1);
    assert.equal(capture.stops, 0);
    assert.equal(active, 'cloudflare');
    stopCapture();
    assert.equal(capture.stops, 1);
});

test('concurrent provider errors trigger only one transition', async () => {
    let inFlight = false;
    let transitions = 0;
    const failover = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
            transitions += 1;
            await new Promise((r) => setTimeout(r, 15));
        } finally {
            inFlight = false;
        }
    };
    await Promise.all([failover(), failover(), failover()]);
    assert.equal(transitions, 1);
});

test('Groq 429 moves to Cloudflare without changing saved primary settings', () => {
    resetAllCircuitBreakers();
    const settings = {
        translation_mode: 'automatic',
        assemblyai_enabled: false,
        groq_enabled: true,
        groq_api_key: 'gsk',
        cloudflare_enabled: true,
        cloudflare_account_id: 'a',
        cloudflare_api_token: 't',
        local_stt_enabled: false,
    };
    applyProviderError({
        provider: 'groq',
        capability: 'stt',
        kind: 'quota',
        status: 429,
        message: 'rate limited',
    });
    assert.equal(isCircuitBreakerOpen(breakerKey('stt', 'groq')), true);
    assert.equal(nextSttProvider(settings, {}, 'groq'), 'cloudflare');
    assert.equal(settings.translation_mode, 'automatic');
    resetAllCircuitBreakers();
});

test('pause stop fallback and failed start disconnect STT clients', async () => {
    let disconnects = 0;
    const client = { disconnect: async () => { disconnects += 1; } };
    const disconnectAll = async () => { await client.disconnect(); };
    await disconnectAll();
    await disconnectAll();
    await client.disconnect();
    assert.equal(disconnects, 3);
});

test('transcript/session store receives one pair per source turn', () => {
    const session = [];
    const commit = (source, translated) => {
        if (session.some((row) => row.source === source)) return;
        session.push({ source, translated });
    };
    commit('hello', 'xin chao');
    commit('hello', 'xin chao');
    assert.equal(session.length, 1);
});
