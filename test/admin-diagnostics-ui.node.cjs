'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
const script = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
const sections = ['api', 'payment', 'trace', 'runtime', 'login'];

function element(values = {}) {
    const attributes = new Map(), classes = new Set(), events = new Map();
    return {
        value: '', textContent: '', hidden: false, dataset: {}, ...values,
        attributes, events,
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); },
        addEventListener(name, handler) { events.set(name, handler); },
        classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) }
    };
}

function setup({ verified = false } = {}) {
    const calls = [], errors = [], nodes = new Map(), forms = new Map(), documentEvents = new Map(), windowEvents = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, element({ id }));
        return nodes.get(id);
    };
    const nav = [...html.matchAll(/<button[^>]*data-tab="([^"]+)"[^>]*data-description="([^"]*)"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/button>/g)]
        .map(([, tab, description, textContent]) => element({ dataset: { tab, description }, textContent }));
    const panels = sections.map(name => element({ dataset: { diagnosticPanel: name } }));
    const tabs = sections.map(name => element({ dataset: { diagnosticTab: name } }));
    const views = [...html.matchAll(/<section id="([^"]+)" class="view"/g)].map(([, id]) => node(id));
    node('tabs').querySelectorAll = () => nav;
    const tokens = new Map(verified ? [['secondary', 'verified']] : []);
    const context = vm.createContext({
        selected: 'overview', selectedDiagnostic: 'api', savedBaseUrl: '', SECONDARY_KEY: 'secondary',
        autoRefreshStarted: 0, autoRefreshFailures: 0,
        Date, $: node, location: { hash: '' },
        localStorage: { getItem: key => tokens.get(key) || null, setItem: (key, value) => tokens.set(key, value) },
        document: {
            title: '', addEventListener: (name, handler) => documentEvents.set(name, handler),
            querySelectorAll(selector) {
                if (selector === '.view') return views;
                if (selector === '[data-diagnostic-panel]') return panels;
                if (selector === '[data-diagnostic-tab]') return tabs;
                throw new Error('Unexpected selector: ' + selector);
            }
        },
        window: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
        history: { replaceState(_state, _title, hash) { context.location.hash = hash; } },
        async perform(action) { try { return await action(); } catch (error) { errors.push(error); } },
        notice() {}, logout() {},
        async loadApi() { calls.push('api'); context.savedBaseUrl = 'https://orbitcard.test'; },
        async loadOverview() { calls.push('overview'); },
        async loadSecurity() { calls.push('security'); },
        async loadCards() { calls.push('cards'); },
        async loadLogs() { calls.push('runtime'); },
        async loadLoginLogs() { calls.push('login'); },
        async loadManualOrders() { calls.push('orders'); },
        async loadManualCatalog() { calls.push('manual-catalog'); },
        async loadCdkPlans() { calls.push('cdk-plans'); },
        async loadCdks() { calls.push('cdks'); },
        form: (id, handler) => forms.set(id, handler),
        async request(url, body) {
            calls.push({ url, body });
            assert.equal(url, '/api/admin/verify-secondary');
            return { secondaryToken: 'verified' };
        }
    });
    vm.runInContext(script.slice(script.indexOf('async function loadSelected()'), script.indexOf('\nfunction form(')), context);
    vm.runInContext(script.slice(script.indexOf("form('unlockForm'"), script.indexOf("form('generateForm'")), context);
    return { context, calls, errors, node, panels, tabs, nav, views, forms, tokens, documentEvents, windowEvents };
}

test('the diagnostics hub owns every log viewer and test entry without duplicate DOM identifiers', () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, 'moved panels must not duplicate existing event targets');
    const hub = html.match(/<section id="diagnostics"[\s\S]*?<\/section>/)?.[0];
    assert.ok(hub);
    for (const name of sections) {
        assert.match(hub, new RegExp(`data-diagnostic-tab="${name}"[^>]*aria-controls="diagnostic-${name}"`));
        assert.match(hub, new RegExp(`id="diagnostic-${name}" data-diagnostic-panel="${name}"`));
    }
    for (const id of ['testApi', 'diagPay', 'diagnosticLog', 'diagTraceLog', 'runtimeLogs', 'loginLogs', 'manualOrderRows']) {
        assert.match(hub, new RegExp(`id="${id}"`));
    }
    assert.doesNotMatch(html, /data-tab="logs"|name="manualMode"/);
    const manual = html.match(/<section id="manual"[\s\S]*?<\/section>/)[0];
    assert.match(manual, /id="manualCdk" required/);
    assert.match(manual, /data-open-diagnostic="payment"/);
    assert.match(manual, /data-open-diagnostic="trace"/);
});

test('legacy logs links resolve to runtime without loading payment configuration', async () => {
    const f = setup();
    await f.context.selectView('logs');
    assert.equal(f.context.selected, 'diagnostics');
    assert.equal(f.context.selectedDiagnostic, 'runtime');
    assert.equal(f.context.location.hash, '#diagnostics/runtime');
    assert.deepEqual(f.calls, ['runtime']);
    assert.equal(f.node('viewTitle').textContent, '调试与日志');
    assert.deepEqual(f.views.filter(view => !view.hidden).map(view => view.id), ['diagnostics']);
    assert.deepEqual(f.errors, []);
});

test('all five diagnostics routes show only their selected panel and load the relevant read-only data', async () => {
    const expected = { api: ['api'], payment: ['api'], trace: ['orders'], runtime: ['runtime'], login: ['login'] };
    for (const section of sections) {
        const f = setup({ verified: true });
        await f.context.selectView('diagnostics/' + section);
        assert.deepEqual(f.calls, expected[section], section);
        assert.deepEqual(f.panels.filter(panel => !panel.hidden).map(panel => panel.dataset.diagnosticPanel), [section]);
        assert.equal(f.tabs.filter(tab => tab.attributes.get('aria-pressed') === 'true').length, 1);
        assert.equal(f.tabs.find(tab => tab.dataset.diagnosticTab === section).classList.contains('active'), true);
        assert.equal(f.nav.find(tab => tab.dataset.tab === 'diagnostics').attributes.get('aria-current'), 'page');
        assert.equal(f.context.location.hash, '#diagnostics/' + section);
        assert.deepEqual(f.errors, []);
    }
});

test('refresh and leaving then reopening the hub preserve the selected log category', async () => {
    const f = setup();
    await f.context.selectView('diagnostics/login');
    await f.node('reload').onclick();
    await f.context.loadSelected();
    assert.deepEqual(f.calls, ['login', 'login', 'login']);
    await f.context.selectView('overview');
    await f.context.selectView('diagnostics');
    assert.equal(f.context.selectedDiagnostic, 'login');
    assert.equal(f.context.location.hash, '#diagnostics/login');
    assert.deepEqual(f.calls, ['login', 'login', 'login', 'overview', 'login']);
});

test('order history waits for secondary authentication and loads in place after verification', async () => {
    const f = setup();
    await f.context.selectView('diagnostics/trace');
    assert.deepEqual(f.calls, []);
    f.node('secondaryPassword').value = 'fixture-password';
    await f.forms.get('unlockForm')();
    assert.equal(f.calls[0].url, '/api/admin/verify-secondary');
    assert.equal(f.calls[0].body.password, 'fixture-password');
    assert.deepEqual(f.calls.slice(1), ['orders']);
    assert.equal(f.context.selectedDiagnostic, 'trace');
    assert.equal(f.context.location.hash, '#diagnostics/trace');
    assert.equal(f.node('secondaryPassword').value, '');
    await f.node('reload').onclick();
    assert.deepEqual(f.calls.slice(1), ['orders', 'orders']);
});

test('hash navigation restores a category and invalid categories fall back without leaving the hub', async () => {
    const f = setup();
    f.context.location.hash = '#diagnostics/runtime';
    await f.windowEvents.get('hashchange')();
    assert.equal(f.context.selectedDiagnostic, 'runtime');
    assert.deepEqual(f.calls, ['runtime']);
    await f.context.selectView('diagnostics/unknown');
    assert.equal(f.context.selectedDiagnostic, 'api');
    assert.equal(f.context.location.hash, '#diagnostics/api');
    assert.deepEqual(f.calls, ['runtime', 'api']);
    await f.context.selectView('missing-page');
    assert.equal(f.context.location.hash, '#diagnostics/api');
    assert.deepEqual(f.calls, ['runtime', 'api']);
});

test('category buttons and cross-page shortcuts select the same read-only hub routes', async () => {
    const f = setup();
    for (const dataset of [{ diagnosticTab: 'runtime' }, { openDiagnostic: 'login' }]) {
        f.documentEvents.get('click')({ target: { closest: () => ({ dataset }) } });
        await Promise.resolve();
    }
    assert.equal(f.context.selectedDiagnostic, 'login');
    assert.deepEqual(f.calls, ['runtime', 'login']);
    assert.deepEqual(f.errors, []);
});
