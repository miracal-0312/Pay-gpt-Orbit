'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const previousOrbitcardKey = process.env.ORBITCARD_API_KEY;
process.env.ORBITCARD_API_KEY = 'key';
after(() => {
    if (previousOrbitcardKey === undefined) delete process.env.ORBITCARD_API_KEY;
    else process.env.ORBITCARD_API_KEY = previousOrbitcardKey;
});
function load(name, mocks = {}) {
    const filename = path.resolve(__dirname, '..', name), module = { exports: {} }, real = createRequire(filename);
    new Function('require','module','exports','__dirname',fs.readFileSync(filename,'utf8'))(
        id => Object.hasOwn(mocks,id) ? mocks[id] : real(id),module,module.exports,path.dirname(filename));
    return module.exports;
}
const session = { accessToken: 'synthetic-token', user: { email: 'customer@example.test' }, account: {} };
function fixture(overrides = {}) {
    const events = [], activeJobs = new Set();
    const store = { acquirePaymentLock: require('./helpers/payment-locks.cjs')().acquirePaymentLock,
        verifyCdkDetails: async () => ({ type: '自助', plan_type: 'plus' }), getRunningTaskByCdk: async () => null,
        getMaintenanceModeState: async () => ({}), getGptApiConfig: async () => ({ enabled: true, api_key: 'key', orbitcard_card_id: '42', base_url: 'https://orbitcard.test' }),
        getMaxConcurrentActivations: async () => 1,
        createOrbitcardTask: async input => { events.push(['claim',input]); return { jobKey: 'job', orbitcardClientOrderNo: 'original' }; },
        settleOrbitcardTask: async (...args) => { events.push(['settle',...args]); return { applied: true }; }, ...overrides
    };
    const handler = require('../activation-service')({ store, activeJobs, ensureStoreReady: async () => {},
        runWorker: async input => { events.push(['worker',input]); }, log: () => {} });
    async function request(body = { cdk: 'CDK-TEST', session: JSON.stringify(session) }) {
        const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return data; } };
        await handler({ body },res); return res;
    }
    return { store, handler, request, events, activeJobs };
}
test('malformed/incomplete/expired Sessions are rejected before touching a CDK', async () => {
    const f = fixture({ verifyCdkDetails: async () => { throw new Error('must not reach database'); } });
    for (const input of ['opaque-token','{}',JSON.stringify({ ...session, user: {} }),JSON.stringify({ ...session, expires: '2000-01-01' })]) {
        assert.equal((await f.request({ cdk: 'CDK-TEST', session: input })).code,400);
    }
    assert.deepEqual(f.events,[]);
});
test('disabled/unconfigured Orbitcard refuses new work without claiming a CDK', async () => {
    const old = process.env.ORBITCARD_API_SECRET;
    try {
        process.env.ORBITCARD_API_SECRET = 'test-secret';
        const disabled = fixture({ getGptApiConfig: async () => ({ enabled: false }) });
        assert.equal((await disabled.request()).code,503); assert.deepEqual(disabled.events,[]);
        delete process.env.ORBITCARD_API_SECRET;
        const missing = fixture(); assert.equal((await missing.request()).code,503); assert.deepEqual(missing.events,[]);
    } finally { if (old === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = old; }
});
test('existing Orbitcard or historical reservations resume even when new orders are paused', async () => {
    for (const provider of ['orbitcard','history']) {
        const f = fixture({ getRunningTaskByCdk: async () => ({ job_key: 'original-job', status: 'manual', ...(provider === 'orbitcard' ? { orbitcard_client_order_no: 'original' } : {}) }),
            getGptApiConfig: async () => { throw new Error('must not start a replacement'); } });
        const res = await f.request(); assert.equal(res.data.provider,provider); assert.equal(res.data.jobKey,'original-job'); assert.deepEqual(f.events,[]);
    }
});
test('a waiting payment retry resumes only with the same account and API Key',async () => {
    const old=process.env.ORBITCARD_API_SECRET;process.env.ORBITCARD_API_SECRET='test-secret';
    try {
        const keyHash=require('node:crypto').createHash('sha256').update('key').digest('hex');
        const f=fixture({verifyCdkDetails:async()=>({type:'自助',plan_type:'plus',used_at:'reserved'}),
            getRunningTaskByCdk:async()=>({job_key:'attempt-2',status:'running',orbitcard_state:'retry_waiting',
                orbitcard_client_order_no:'ORDER-2',orbitcard_retry_root_job_key:'attempt-1',orbitcard_retry_attempt_no:2,
                orbitcard_retry_first_card_id:42,orbitcard_api_key_hash:keyHash,orbitcard_email:session.user.email,
                orbitcard_base_url:'https://orbitcard.test'}),
            claimOrbitcardRetryTask:async (...args)=>{f.events.push(['retry-claim',...args]);return true;},
            createOrbitcardTask:async()=>{throw Error('must keep existing CDK chain');}});
        assert.equal((await f.request({cdk:'CDK-TEST',session:JSON.stringify({...session,user:{email:'other@example.test'}})})).code,409);
        const accepted=await f.request();assert.equal(accepted.code,200);
        assert.equal(accepted.data.jobKey,'attempt-1');
        assert.equal(f.events.filter(event=>event[0]==='retry-claim').length,1);
        assert.equal(f.events.filter(event=>event[0]==='worker').length,1);
    } finally {if(old===undefined)delete process.env.ORBITCARD_API_SECRET;else process.env.ORBITCARD_API_SECRET=old;}
});
test('admission capacity is reserved before an asynchronous task insert', async () => {
    const old = process.env.ORBITCARD_API_SECRET; process.env.ORBITCARD_API_SECRET = 'test-secret';
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), acquired = new Promise(resolve => { entered = resolve; });
    try {
        const f = fixture({ createOrbitcardTask: async () => { entered(); await gate; return { jobKey: 'job', orbitcardClientOrderNo: 'original' }; } });
        const first = f.request(); await acquired;
        assert.equal(f.activeJobs.size,1);
        assert.equal((await f.request({ cdk: 'OTHER-CDK', session: JSON.stringify(session) })).code,429);
        release(); assert.equal((await first).code,200);
        assert.equal(f.events.filter(event => event[0] === 'worker').length,1);
    } finally { release(); if (old === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = old; }
});
test('a synchronous dispatch failure only releases its own still-prepared attempt', async () => {
    const old = process.env.ORBITCARD_API_SECRET; process.env.ORBITCARD_API_SECRET = 'test-secret';
    try {
        const f = fixture();
        const handler = require('../activation-service')({ store: f.store, activeJobs: f.activeJobs, ensureStoreReady: async () => {}, log() {}, runWorker() { throw new Error('dispatch failure'); } });
        const res = { status(code) { this.code=code; return this; }, json(data) { this.data=data; } };
        await handler({ body: { cdk: 'CDK-TEST', session: JSON.stringify(session) } },res);
        const settlement = f.events.find(event => event[0] === 'settle');
        assert.equal(settlement[1],'job'); assert.equal(settlement[2].expectedState,'prepared'); assert.equal(settlement[2].orbitcardState,'rejected');
        assert.equal(f.activeJobs.size,0);
    } finally { if (old === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = old; }
});

test('restart recovery releases only prepared tasks and never creates a replacement order', async () => {
    const calls = [], states = [], audits = [];
    const store = { acquirePaymentLock: require('./helpers/payment-locks.cjs')().acquirePaymentLock,
        settleOrbitcardTask: async (key, state) => { states.push([key,state]); return { applied: true }; },
        getGptApiConfig: async () => ({ enabled: false, api_key: 'saved-key' }),
        getTaskStatus: async key => ({ job_key: key, cdk_code: 'CDK-TEST', status: 'manual',
            orbitcard_state: key === 'prepared' ? 'prepared' : 'manual', orbitcard_client_order_no: 'fixed-identity' })
    };
    const recovery = require('../order-recovery')({ store, activeJobs: new Set(), audit: event => audits.push(event),
        query: { refresh: async input => { calls.push(input); return { success: true, applied: true }; } } });
    await recovery.refreshTask({ job_key: 'prepared', cdk_code: 'CDK-TEST', orbitcard_state: 'prepared' });
    assert.equal(states[0][1].expectedState,'prepared'); assert.equal(states[0][1].orbitcardState,'rejected'); assert.equal(calls.length,0);
    await recovery.refreshTask({ job_key: 'unknown', cdk_code: 'CDK-TEST', orbitcard_state: 'manual', orbitcard_client_order_no: 'fixed-identity' });
    assert.equal(calls.length,1); assert.equal(calls[0].task.orbitcard_client_order_no,'fixed-identity'); assert.equal(calls[0].cfg.enabled,false);
    assert.equal(states.length,1); assert.equal(audits[0].event,'recovery_unsubmitted');
});
test('background reconciliation skips active workers and applies backoff to failed queries', async () => {
    let queries = 0, touches = 0;
    const recovery = require('../order-recovery')({
        activeJobs: new Set(['active']), audit() {},
        store: { acquirePaymentLock: require('./helpers/payment-locks.cjs')().acquirePaymentLock,
            getTaskStatus: async key => ({ job_key: key, cdk_code: 'CDK-TEST', orbitcard_state: 'manual' }),
            listRecoverableOrbitcardTasks: async () => [{ job_key: 'active', cdk_code: 'CDK-TEST', orbitcard_state: 'pending' }, { job_key: 'unknown', cdk_code: 'CDK-TEST', orbitcard_state: 'manual' }],
            getGptApiConfig: async () => ({}), noteQueryAttempt: async () => { touches++; } },
        query: { refresh: async () => { queries++; return { success: false, retryAfterMs: 60000 }; } }
    });
    await Promise.all([recovery.recover(),recovery.recover()]); await recovery.recover();
    assert.equal(queries,1); assert.equal(touches,1);
});
test('historical tasks retain reservations and migrations do not drop legacy data', async () => {
    const executed = [], columns = [];
    const core = {
        runQuery: async sql => {
            if (sql.startsWith('SELECT config_key')) return [{ config_key: 'admin_password_hash', config_value: 'existing' }, { config_key: 'admin_secondary_password_hash', config_value: 'existing' }];
            if (sql.startsWith('SELECT cdk_code FROM task_logs')) return [{ cdk_code: 'HISTORICAL-CDK' }];
            return [];
        },
        runExecute: async (sql,args) => { executed.push([sql,args]); return { affectedRows: 1 }; },
        withTransaction: async fn => fn({}), ensureColumn: async (table,column) => columns.push([table,column]), ensureGptApiConfigDefaults: async () => {}
    };
    const store = load('mysql-store.js', { './mysql-core': core, './orbitcard-client': { summary: value => value } });
    await store.ensureReady();
    assert.ok(executed.some(([sql]) => sql.includes('used_at = COALESCE(used_at')));
    assert.ok(executed.some(([sql]) => sql.includes("status = 'manual'")));
    assert.ok(executed.every(([sql]) => !/DROP|TRUNCATE|used_at = NULL/.test(sql)));
    assert.ok(columns.every(([table]) => ['app_config','cdk_codes','task_logs','orbitcard_admin_orders'].includes(table)));
});
test('new tasks store only the account preview and never a submitted Session', async () => {
    let insert;
    const store = load('mysql-store.js', { './mysql-core': { runExecute: async (...args) => { insert=args; }, withTransaction() {}, runQuery() {} }, './orbitcard-client': { summary: value => value } });
    await store.createTaskLog({ tokenPreview: session.user.email, cdkCode: 'TEST', sessionPayload: JSON.stringify(session) });
    assert.ok(!insert[0].includes('session_payload')); assert.ok(!JSON.stringify(insert[1]).includes('synthetic-token'));
});
test('administrator signatures require a random secret and secondary auth cannot be bypassed', async () => {
    const old = process.env.ADMIN_TOKEN_SECRET;
    const auth = require('../admin-auth');
    try {
        delete process.env.ADMIN_TOKEN_SECRET; assert.throws(() => auth.resolveAdminTokenSecret());
        process.env.ADMIN_TOKEN_SECRET = 'x'.repeat(32);
        const middleware = auth.createRequireSecondaryAuth({ getAdminAuthConfig: async () => ({ secondaryPasswordVersion: 2 }) },async () => {});
        let passed = false;
        const response = { status(code) { this.code=code; return this; }, json(data) { this.data=data; } };
        await middleware({ headers: {}, socket: { remoteAddress: '127.0.0.1' } },response,() => { passed=true; });
        assert.equal(response.code,403); assert.equal(passed,false);
        const token = auth.issueSecondaryToken(2,'127.0.0.1').token;
        await middleware({ headers: { 'x-admin-secondary-token': token }, socket: { remoteAddress: '127.0.0.1' } },response,() => { passed=true; });
        assert.equal(passed,true);
    } finally { if (old === undefined) delete process.env.ADMIN_TOKEN_SECRET; else process.env.ADMIN_TOKEN_SECRET=old; }
});

test('API-only HTTP server serves the new UI, protects management and has no retired routes', async t => {
    const old = process.env.ADMIN_TOKEN_SECRET; process.env.ADMIN_TOKEN_SECRET='s'.repeat(32);
    const fakeStore = {
        ensureReady: async () => {}, getAdminPaths: async () => ({ loginPath: 'admin-login',panelPath: 'admin' }),
        getAdminAuthConfig: async () => ({ passwordVersion: 1 }), getMaxConcurrentActivations: async () => 1,
        verifyCdkDetails: async () => ({ cdk_code: 'CDK-TEST',type: '自助',plan_type: 'plus' }), getRunningTaskByCdk: async () => null,
        getMaintenanceModeState: async () => ({}), getGptApiConfig: async () => ({ enabled: false }),
        runQuery: async () => [{ ok: 1 }], getAdminData: async () => ({ stats: { total: 0 },config: {},logs: [] })
    };
    const { app } = load('server.js', { './mysql-store': fakeStore, './runtime-log': { push() {}, initialize() {} } });
    const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (old === undefined) delete process.env.ADMIN_TOKEN_SECRET; else process.env.ADMIN_TOKEN_SECRET=old; });
    const base = `http://127.0.0.1:${server.address().port}`;
    const home = await fetch(base); assert.equal(home.status,200); assert.ok((await home.text()).includes('/app.js'));
    assert.equal((await fetch(base+'/api/admin/data')).status,401);
    assert.equal((await fetch(base+'/api/admin/orbitcard/cards')).status,401);
    const token = require('../admin-auth').issueAdminToken(1,'admin@example.test').token;
    const headers = { Authorization: `Bearer ${token}` };
    for (const route of ['/api/admin/browser-pool','/api/admin/cards','/api/admin/addresses','/api/admin/proxies','/api/admin/hcaptcha','/api/admin/checkout/plans','/api/admin/billing']) assert.equal((await fetch(base+route,{ headers })).status,404,route);
    assert.equal((await fetch(base+'/api/webhooks/card-issue',{ method: 'POST',headers: { 'Content-Type': 'application/json' },body:'{}' })).status,404);
    assert.equal((await fetch(base+'/api/public/payment-region')).status,404);
    assert.equal((await fetch(base+'/subscription')).status,404);
    assert.equal((await fetch(base+'/api/health')).status,200);
    const rejected = await fetch(base+'/api/run-process',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ cdk:'CDK-TEST',session:JSON.stringify(session) }) });
    assert.equal(rejected.status,503); assert.ok((await rejected.json()).message.includes('Orbitcard'));
});
test('production dependency graph and Dockerfile contain no browser or Python runtimes', () => {
    const root = path.resolve(__dirname,'..'), lock = JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
    assert.deepEqual(Object.keys(require('../package.json').dependencies).sort(),['axios','express','mysql2','ws']);
    assert.ok(Object.keys(lock.packages).every(key => !/playwright|puppeteer|torch|opencv|transformers/.test(key)));
    const dockerfile = fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
    assert.ok(!/python|pip install|playwright|chromium|xvfb|vnc|apt-get/i.test(dockerfile));
    assert.ok(fs.readFileSync(path.join(root,'.dockerignore'),'utf8').split('\n').includes('data'));
    for (const file of ['index.js','stripe-payment.js','payment-retry.js','local-worker.js','session-auth.js','hcaptcha/solver.py','requirements-hcaptcha.txt']) assert.equal(fs.existsSync(path.join(root,file)),false,file);
});

test('HTTP redemption carries the Session only to Orbitcard and exposes live verification before final settlement', async t => {
    const oldSecret = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_SECRET = 'fixture-secret';
    let finish, visible, completed;
    const gate = new Promise(resolve => { finish=resolve; }), challengeReady = new Promise(resolve => { visible=resolve; });
    const done = new Promise(resolve => { completed=resolve; });
    const events = [], writes = [], tasks = new Map();
    const task = { job_key: 'live-job', cdk_code: 'CDK-TEST', orbitcard_client_order_no: 'stable-client', orbitcard_state: 'prepared', status: 'running', orbitcard_email: session.user.email };
    const store = { acquirePaymentLock: require('./helpers/payment-locks.cjs')().acquirePaymentLock,
        ensureReady: async () => {}, getAdminPaths: async () => ({ loginPath: 'admin-login',panelPath: 'admin' }),
        verifyCdkDetails: async () => ({ type: '自助',plan_type: 'plus' }), getRunningTaskByCdk: async () => null,
        getMaintenanceModeState: async () => ({}), getMaxConcurrentActivations: async () => 1,
        getGptApiConfig: async () => ({ enabled: true,api_key: 'fixture-key',orbitcard_card_id: '42',base_url: 'https://orbitcard.test' }),
        createOrbitcardTask: async input => { writes.push(input); tasks.set(task.job_key,task); return { jobKey: task.job_key,orbitcardClientOrderNo: task.orbitcard_client_order_no }; },
        settleOrbitcardTask: async (job, update) => { writes.push(update); Object.assign(tasks.get(job),{ status:update.status,progress:update.progress,message:update.message,orbitcard_state:update.orbitcardState,gpt_api_order_id:update.gptApiOrderId }); return { applied:true }; },
        getTaskStatus: async job => tasks.get(job), getOrbitcardTaskByCdk: async () => task,
        safeOrder: () => ({})
    };
    const challenge = { id:'challenge',url:'https://challenge.example.test/private-captcha',expires_at:new Date(Date.now()+60000).toISOString() };
    const { app, activeJobs } = load('server.js', {
        './mysql-store':store,'./runtime-log':{ push:event => events.push(event) },
        './telegram-notify':{ notifyTelegramEvent:async () => completed() },
        './orbitcard-query':{ refresh:async () => { throw new Error('must not duplicate active polling'); } },
        './orbitcard-worker':{ run:async options => {
            assert.equal(options.session.accessToken,'synthetic-token'); assert.equal(options.clientOrderNo,'stable-client');
            await options.setProgress('running',60,'请完成验证',{ orbitcardState:'pending',gptApiOrderId:'SUB-1' });
            options.broadcast(challenge); visible(); await gate;
            await options.setProgress('success',100,'订阅成功',{ orbitcardState:'success',gptApiOrderId:'SUB-1' });
        } }
    });
    const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(async () => { finish(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (oldSecret===undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET=oldSecret; });
    const base=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(base+'/api/run-process',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ cdk:'CDK-TEST',session:JSON.stringify(session) }) });
    assert.equal(response.status,200); assert.equal((await response.json()).provider,'orbitcard'); await challengeReady;
    const status=await fetch(base+'/api/cdk/orbitcard/status',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ cdk:'CDK-TEST' }) });
    const current=await status.json(); assert.equal(current.captcha.url,challenge.url); assert.equal(current.data.order_id,'SUB-1');
    assert.ok(!JSON.stringify(events).includes('private-captcha')); assert.ok(!JSON.stringify(events).includes('synthetic-token'));
    assert.ok(!JSON.stringify(writes).includes('synthetic-token'));
    finish(); await done; await new Promise(resolve => setImmediate(resolve));
    assert.equal(task.status,'success'); assert.equal(activeJobs.size,0);
});
