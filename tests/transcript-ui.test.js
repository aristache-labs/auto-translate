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

function withFakeDom(t) {
    const previousDocument = globalThis.document;
    globalThis.document = {
        createElement: () => fakeElement(),
        getElementById: () => null,
    };
    t.after(() => { globalThis.document = previousDocument; });
    return new TranscriptUI(fakeElement());
}

test('short fragments without punctuation merge into one bubble', (t) => {
    const ui = withFakeDom(t);
    ui.addOriginal('In this time together', null, 'en');
    ui.addTranslation('În acest timp împreună');
    ui.addOriginal('to be with you and', null, 'en');
    ui.addTranslation('să fii cu mine și');

    assert.equal(ui.segments.length, 1);
    assert.equal(ui.segments[0].original, 'In this time together to be with you and');
    assert.equal(ui.segments[0].translation, 'În acest timp împreună să fii cu mine și');
});

test('up to three short sentences share one conversation block', (t) => {
    const ui = withFakeDom(t);
    ui.addOriginal('First sentence.', null, 'en');
    ui.addTranslation('Prima propoziție.');
    ui.addOriginal('Second sentence.', null, 'en');
    ui.addTranslation('A doua propoziție.');
    ui.addOriginal('Third sentence.', null, 'en');
    ui.addTranslation('A treia propoziție.');
    ui.addOriginal('Fourth sentence.', null, 'en');
    ui.addTranslation('A patra propoziție.');

    assert.equal(ui.segments.length, 2);
    assert.equal(
        ui.segments[0].original,
        'First sentence. Second sentence. Third sentence.'
    );
    assert.equal(ui.segments[1].original, 'Fourth sentence.');
    assert.equal(
        ui.segments[0].translation,
        'Prima propoziție. A doua propoziție. A treia propoziție.'
    );
});

test('queued fragments still merge when translations arrive later', (t) => {
    const ui = withFakeDom(t);
    ui.addOriginal('In this time together', null, 'en');
    ui.addOriginal('to be with you and', null, 'en');
    ui.addTranslation('În acest timp împreună');
    ui.addTranslation('să fii cu mine și');

    assert.equal(ui.segments.length, 1);
    assert.equal(ui.segments[0].original, 'In this time together to be with you and');
    assert.equal(ui.segments[0].translation, 'În acest timp împreună să fii cu mine și');
    assert.equal(ui.segments[0].pendingTranslations, 0);
});

test('a growing block keeps its completed translation visible while the next part is pending', (t) => {
    const ui = withFakeDom(t);
    ui.configure({ viewMode: 'dual', sourceLanguage: 'en', targetLanguage: 'ro' });
    ui.addOriginal('First sentence.', null, 'en');
    ui.addTranslation('Prima propoziție.');
    ui.addOriginal('Second sentence.', null, 'en');

    const html = ui.contentEl.innerHTML;
    assert.equal(ui.segments.length, 1);
    assert.match(html, /Prima propoziție\./);
    assert.match(html, /translation-pending is-inline/);
    assert.match(html, />Translating</);
});

test('speaker changes always start a new conversation block', (t) => {
    const ui = withFakeDom(t);
    ui.addOriginal('We can keep this compact.', '1', 'en');
    ui.addTranslation('Putem păstra acest lucru compact.');
    ui.addOriginal('I have another idea.', '2', 'en');
    ui.addTranslation('Am o altă idee.');

    assert.equal(ui.segments.length, 2);
    assert.equal(ui.segments[0].speaker, '1');
    assert.equal(ui.segments[1].speaker, '2');
});

test('translation-only streams also group short sentences', (t) => {
    const ui = withFakeDom(t);
    ui.provider = 'qwen';
    ui.addTranslation('Prima propoziție.');
    ui.addTranslation('A doua propoziție.');
    ui.addTranslation('A treia propoziție.');
    ui.addTranslation('A patra propoziție.');

    assert.equal(ui.segments.length, 2);
    assert.equal(
        ui.segments[0].translation,
        'Prima propoziție. A doua propoziție. A treia propoziție.'
    );
});

test('a provisional repeat of the latest final source is not rendered twice', (t) => {
    const ui = withFakeDom(t);
    ui.configure({ viewMode: 'dual', sourceLanguage: 'en', targetLanguage: 'ro' });
    ui.addOriginal('YOU HAVE TO BE ABLE TO BE ABLE TO', null, 'en');
    ui.setProvisional('you have to be able to be able to', null, 'en');

    assert.doesNotMatch(ui.contentEl.innerHTML, /provisional-pair/);
    assert.equal((ui.contentEl.innerHTML.match(/class="transcript-pair(?:\s|")/g) || []).length, 1);
});
