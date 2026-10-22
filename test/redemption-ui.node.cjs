'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
    const nodes = new Map(), timers = new Map();
    let nextTimer = 0, response = null;
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, style: {}, children: [],
            handlers: {}, attributes: {}, textContent: '', parentElement: { setAttribute() {} },
            setAttribute(key, value) { this.attributes[key] = value; }, focus() {},
            addEventListener(event, handler) { this.handlers[event] = handler; },
            replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
        return nodes.get(id);
    };
    const context = vm.createContext({ URL, Date,
        document: { getElementById: node, querySelectorAll: () => [], createElement: () => ({}) },
        setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
        clearTimeout: id => timers.delete(id), setInterval() {},
        fetch: async url => {
            if (url === '/api/public/runtime') return { json: async () => ({ success: false }) };
            if (response instanceof Error) throw response;
            return { ok: true, json: async () => response };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
    vm.runInContext("activeCdk = 'CODE-TEST'; activeJob = 'job-1'; activePlanLabel = 'Plus';", context);
    return { node, timers, context, respond(value) { response = value; },
        refresh: () => vm.runInContext('refresh(false)', context) };
}

test('querying a waiting retry keeps the Session form usable for the same order', async () => {
    const f = setup();
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'retry' } });
    await f.refresh();
    assert.equal(f.node('redeemForm').hidden, false);
    f.node('cdkInput').value = 'CODE-TEST';
    f.node('sessionInput').value = '{"accessToken":"test"}';
    f.respond({ success: true, provider: 'orbitcard', jobKey: 'job-1', status: 'running' });
    await f.node('redeemForm').handlers.submit({ preventDefault() {} });
    assert.equal(f.node('sessionInput').value, '');
    assert.equal(f.node('redeemForm').hidden, true);
});

test('unconfirmed queries and transport errors remove stale captcha links', async () => {
    for (const response of [{ success: false, message: 'unconfirmed' }, new Error('network')]) {
        const f = setup();
        vm.runInContext("challenge({url:'https://example.test/verify',expires_at:new Date(Date.now()+60000).toISOString()})", f.context);
        assert.equal(f.node('captchaBox').children.length, 1);
        f.respond(response); await f.refresh();
        assert.equal(f.node('captchaBox').children.length, 0);
    }
});
