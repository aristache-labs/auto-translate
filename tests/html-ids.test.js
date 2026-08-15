import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_INIT_IDS } from '../src/js/mode-utils.js';

const html = readFileSync(join(process.cwd(), 'src', 'index.html'), 'utf8');
const appJs = readFileSync(join(process.cwd(), 'src', 'js', 'app.js'), 'utf8');

test('current HTML has every required init ID', () => {
    for (const id of REQUIRED_INIT_IDS) {
        assert.ok(html.includes(`id="${id}"`), `missing #${id} in index.html`);
    }
});

test('engine cards and pills use groq|cloudflare|local', () => {
    assert.match(html, /data-engine-class="groq"/);
    assert.match(html, /data-engine-class="cloudflare"/);
    assert.match(html, /data-engine-class="local"/);
    assert.equal(html.includes('data-engine-class="openai"'), false);
    assert.equal(html.includes('data-engine-class="soniox"'), false);
});

test('app.js no longer binds removed Soniox/OpenAI IDs', () => {
    assert.equal(appJs.includes("getElementById('btn-toggle-key')"), false);
    assert.equal(appJs.includes("getElementById('link-soniox')"), false);
    assert.equal(appJs.includes('sonioxClient'), false);
    assert.match(appJs, /btn-toggle-groq-key/);
    assert.match(appJs, /input-groq-key/);
    assert.match(appJs, /input-cloudflare-account-id/);
    assert.match(appJs, /_fallbackInFlight/);
    assert.match(appJs, /showFatalInitError/);
    assert.equal(appJs.includes('JSON.stringify(settings)'), false);
});

test('TranscriptUI contract methods exist in ui.js', () => {
    const ui = readFileSync(join(process.cwd(), 'src', 'js', 'ui.js'), 'utf8');
    assert.match(ui, /addOriginal\(/);
    assert.match(ui, /addTranslation\(/);
    assert.match(ui, /setProvisional\(/);
    assert.equal(ui.includes('addProvisional('), false);
    assert.equal(ui.includes('setOriginal('), false);
    assert.equal(ui.includes('setTranslation('), false);
});

test('split view closes its menu and compact mode has a restore control', () => {
    assert.match(html, /id="btn-restore-toolbar"/);
    assert.match(html, /id="btn-more"[^>]+aria-expanded="false"/);
    assert.match(
        appJs,
        /\['btn-copy', 'btn-clear', 'btn-compact', 'btn-view-mode', 'btn-shortcuts'\]\.forEach/
    );
    assert.match(appJs, /restoreChrome\(\)/);
});
