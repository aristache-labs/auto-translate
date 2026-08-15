import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeClassList {
    constructor() { this.values = new Set(); }
    toggle(name, force) {
        const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
        if (enabled) this.values.add(name);
        else this.values.delete(name);
        return enabled;
    }
    contains(name) { return this.values.has(name); }
}

class FakeElement {
    constructor() {
        this.classList = new FakeClassList();
        this.style = { display: 'none' };
        this.attributes = new Map();
        this.listeners = new Map();
        this.focused = false;
    }
    addEventListener(type, handler) {
        const handlers = this.listeners.get(type) || [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
    }
    emit(type, event = {}) {
        for (const handler of this.listeners.get(type) || []) handler(event);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name); }
    contains(target) { return target === this; }
    focus() { this.focused = true; }
}

const elements = {
    'drag-region': new FakeElement(),
    'overlay-view': new FakeElement(),
    'btn-more': new FakeElement(),
    'more-menu': new FakeElement(),
};
const statusRow = new FakeElement();
const actionRow = new FakeElement();
const documentListeners = new Map();

globalThis.localStorage = {
    getItem: () => '0',
    setItem: () => {},
};
globalThis.window = { addEventListener: () => {} };
globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: (selector) => selector === '.live-status-row' ? statusRow
        : selector === '.live-action-row' ? actionRow : null,
    querySelectorAll: () => [],
    addEventListener: (type, handler) => {
        const handlers = documentListeners.get(type) || [];
        handlers.push(handler);
        documentListeners.set(type, handlers);
    },
};

const shell = await import(`../src/js/ui-shell.js?ui-shell-test=${Date.now()}`);

test('overflow menu exposes its state and Escape returns focus', () => {
    const bound = shell.bindMenu('btn-more', 'more-menu');
    const trigger = elements['btn-more'];
    const menu = elements['more-menu'];

    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    trigger.emit('click', { stopPropagation() {} });
    assert.equal(menu.style.display, '');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');

    for (const handler of documentListeners.get('keydown') || []) {
        handler({ key: 'Escape' });
    }
    assert.equal(menu.style.display, 'none');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(trigger.focused, true);

    bound.close();
});

test('manual compact mode always has a programmatic restore path', () => {
    assert.equal(shell.toggleManualCompact(), true);
    assert.equal(elements['overlay-view'].classList.contains('compact-mode'), true);
    assert.equal(actionRow.classList.contains('chrome-hidden'), true);

    assert.equal(shell.revealChrome(), false, 'ordinary reveal must respect manual compact');
    shell.restoreChrome();

    assert.equal(elements['overlay-view'].classList.contains('compact-mode'), false);
    assert.equal(actionRow.classList.contains('chrome-hidden'), false);
});
