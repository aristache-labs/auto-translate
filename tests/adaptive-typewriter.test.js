import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_VISUAL_LAG_MS,
    commonPrefixLength,
    nextRevealCount,
    textLength,
    visibleText,
} from '../src/js/adaptive-typewriter.js';

test('typewriter reveal always advances and never exceeds the target', () => {
    const next = nextRevealCount({ visible: 4, total: 20, elapsedMs: 16, ageMs: 20 });
    assert.ok(next > 4);
    assert.ok(next <= 20);
});

test('typewriter completes a track at the visual lag ceiling', () => {
    const next = nextRevealCount({
        visible: 2,
        total: 120,
        elapsedMs: 16,
        ageMs: MAX_VISUAL_LAG_MS,
    });
    assert.equal(next, 120);
});

test('queued transcript tracks catch up faster', () => {
    const normal = nextRevealCount({ visible: 0, total: 80, elapsedMs: 32, queuedTracks: 1 });
    const queued = nextRevealCount({ visible: 0, total: 80, elapsedMs: 32, queuedTracks: 3 });
    assert.ok(queued > normal);
});

test('provisional corrections preserve only their stable prefix', () => {
    assert.equal(commonPrefixLength('Hello worl', 'Hello world'), 10);
    assert.equal(commonPrefixLength('Today is', 'Tomorrow is'), 2);
});

test('unicode text is revealed by complete code points', () => {
    assert.equal(textLength('Bună 🌍'), 6);
    assert.equal(visibleText('Bună 🌍', 6), 'Bună 🌍');
});
