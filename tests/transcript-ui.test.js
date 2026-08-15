import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptUI } from '../src/js/ui.js';

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function fakeElement() {
    let html = '';
    return {
        style: { setProperty() {} },
        scrollHeight: 400,
        clientHeight: 300,
        scrollTop: 100,
        parentElement: null,
        get innerHTML() { return html; },
        set innerHTML(value) { html = String(value); },
        set textContent(value) { html = escapeHtml(value); },
        get textContent() { return html; },
        appendChild(child) {
            child.parentElement = this;
            this.child = child;
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
}

test('dual transcript renders aligned source and translation pairs', (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = {
        createElement: () => fakeElement(),
        getElementById: () => null,
    };
    t.after(() => { globalThis.document = previousDocument; });

    const container = fakeElement();
    const ui = new TranscriptUI(container);
    ui.configure({ viewMode: 'dual', sourceLanguage: 'en', targetLanguage: 'ro' });
    ui.addOriginal('Good morning', null, 'en');
    ui.addTranslation('Bună dimineața');

    const html = container.child.innerHTML;
    assert.match(html, /class="transcript-pair is-current"/);
    assert.match(html, /Original speech/);
    assert.match(html, /Live translation/);
    assert.match(html, /Good morning/);
    assert.match(html, /Bună dimineața/);
    assert.match(html, />RO</);
});

test('single transcript remains translation focused', (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = {
        createElement: () => fakeElement(),
        getElementById: () => null,
    };
    t.after(() => { globalThis.document = previousDocument; });

    const container = fakeElement();
    const ui = new TranscriptUI(container);
    ui.configure({ viewMode: 'single', targetLanguage: 'ro' });
    ui.addOriginal('Thank you', null, 'en');
    ui.addTranslation('Vă mulțumesc');

    const html = container.child.innerHTML;
    assert.match(html, /transcript-stage-single/);
    assert.match(html, /Vă mulțumesc/);
    assert.doesNotMatch(html, />Thank you</);
});
