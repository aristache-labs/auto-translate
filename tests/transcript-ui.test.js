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

test('continuous speech stays in one paragraph instead of splitting by sentence count', (t) => {
    const ui = withFakeDom(t);
    for (let index = 1; index <= 6; index += 1) {
        ui.addOriginal(`Sentence ${index}.`, null, 'en');
        ui.addTranslation(`Propoziția ${index}.`);
    }

    assert.equal(ui.segments.length, 1);
    assert.equal(
        ui.segments[0].original,
        'Sentence 1. Sentence 2. Sentence 3. Sentence 4. Sentence 5. Sentence 6.'
    );
});

test('a genuinely large paragraph starts a new conversation block', (t) => {
    const ui = withFakeDom(t);
    ui.addOriginal(`Opening ${'context '.repeat(85)}`, null, 'en');
    ui.addTranslation(`Introducere ${'context '.repeat(85)}`);
    ui.addOriginal(`Next ${'thought '.repeat(85)}`, null, 'en');

    assert.equal(ui.segments.length, 2);
});

test('overlapping STT boundary words are folded into the existing paragraph', (t) => {
    const ui = withFakeDom(t);
    ui.addOriginal('We jump into this extraordinary episode.', null, 'en');
    ui.addTranslation('Intrăm în acest episod extraordinar.');
    ui.addOriginal('episode. My team was showing me something.', null, 'en');
    ui.addTranslation('episod extraordinar. Echipa mea îmi arăta ceva.');

    assert.equal(ui.segments.length, 1);
    assert.equal(
        ui.segments[0].original,
        'We jump into this extraordinary episode. My team was showing me something.'
    );
    assert.equal(
        ui.segments[0].translation,
        'Intrăm în acest episod extraordinar. Echipa mea îmi arăta ceva.'
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

test('translation-only streams also form continuous paragraphs', (t) => {
    const ui = withFakeDom(t);
    ui.provider = 'qwen';
    ui.addTranslation('Prima propoziție.');
    ui.addTranslation('A doua propoziție.');
    ui.addTranslation('A treia propoziție.');
    ui.addTranslation('A patra propoziție.');

    assert.equal(ui.segments.length, 1);
    assert.equal(
        ui.segments[0].translation,
        'Prima propoziție. A doua propoziție. A treia propoziție. A patra propoziție.'
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

test('a short meaningful provisional tail is not repeated as a new live line', (t) => {
    const ui = withFakeDom(t);
    ui.configure({ viewMode: 'dual', sourceLanguage: 'en', targetLanguage: 'ro' });
    ui.addOriginal('We jump into this extraordinary episode.', null, 'en');
    ui.setProvisional('episode.', null, 'en');

    assert.doesNotMatch(ui.contentEl.innerHTML, /provisional-pair/);
});

test('a continuation partial stays on the current pair instead of a listening-live row', (t) => {
    const ui = withFakeDom(t);
    ui._reducedMotion = true;
    ui.configure({ viewMode: 'dual', sourceLanguage: 'en', targetLanguage: 'ro' });
    ui.addOriginal('Hello everyone. Welcome back. I am so', null, 'en');
    ui.addTranslation('Bună ziua tuturor. Bun venit înapoi.');
    ui.setProvisional('happy', null, 'auto');
    ui.setTranslationProvisional('I. În ceea ce privește');

    const html = ui.contentEl.innerHTML;
    assert.doesNotMatch(html, /Listening live/i);
    assert.doesNotMatch(html, /provisional-pair/);
    assert.equal((html.match(/class="transcript-pair(?:\s|")/g) || []).length, 1);
    assert.match(html, /live-tail/);
    assert.match(html, /happy/);
    assert.match(html, /I\. În ceea ce privește/);
});

test('clearProvisional can keep the live translation draft on the current pair', (t) => {
    const ui = withFakeDom(t);
    ui._reducedMotion = true;
    ui.configure({ viewMode: 'dual', sourceLanguage: 'en', targetLanguage: 'ro' });
    ui.addOriginal('I am so', null, 'en');
    ui.setProvisional('happy', null, 'en');
    ui.setTranslationProvisional('sunt atât de');
    ui.clearProvisional({ keepTranslation: true });
    ui.addOriginal('happy', null, 'en');

    assert.equal(ui.segments.length, 1);
    assert.equal(ui.segments[0].original, 'I am so happy');
    assert.equal(ui.translationProvisionalText, 'sunt atât de');
    assert.doesNotMatch(ui.contentEl.innerHTML, /Listening live/i);
    assert.match(ui.contentEl.innerHTML, /sunt atât de/);
});

test('live translation draft accepts a rephrased longer update', (t) => {
    const ui = withFakeDom(t);
    ui._reducedMotion = true;
    ui.setTranslationProvisional('Bună ziua tuturor');
    ui.translationProvisionalVisible = 20;
    ui.setTranslationProvisional('Bună ziua toată lumea, vă mulțumim pentru venirea înapoi.');
    assert.equal(
        ui.translationProvisionalText,
        'Bună ziua toată lumea, vă mulțumim pentru venirea înapoi.',
    );
});
