// SPDX-License-Identifier: GPL-3.0-or-later
//
// The front end is executed, not just fetched.
//
// This file exists because of a real escape: public/app.js had an unbalanced
// parenthesis in a deeply nested h() call. Every server-side test passed -- the
// file was served, it contained the expected endpoint strings -- but the browser
// refused to parse it, so the page sat on a loading state and the user saw a blank
// screen with "Uncaught SyntaxError: missing ) after argument list".
//
// So these tests run the file the way the browser does: parse it with the real
// JavaScript parser, execute it against a minimal DOM, and check that the views
// actually render. A syntax error, a missing DOM API or a broken view is now a
// failing test rather than a bug report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createDom, createFetchStub } from './support/dom.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appSource = readFileSync(join(projectRoot, 'public', 'app.js'), 'utf8');
const cssSource = readFileSync(join(projectRoot, 'public', 'app.css'), 'utf8');
const indexSource = readFileSync(join(projectRoot, 'public', 'index.html'), 'utf8');

/**
 * Execute public/app.js in a fresh context.
 *
 * `routes` is the fetch table; `onRequest` observes every API call so a test can
 * assert which endpoints a flow touched.
 */
async function runApp({ routes = {}, settleMs = 60 } = {}) {
    const dom = createDom();
    const requests = [];
    const clock = {
        intervals: new Set(),
        // The views start a periodic refresh. In a browser that is the point; in a
        // test it would keep the process alive after the assertions finish, so every
        // timer here is unref'd. The tests drive rendering explicitly and never wait
        // on a tick.
        setTimeout: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
        },
        clearTimeout: (handle) => clearTimeout(handle),
        setInterval: (fn, ms) => {
            const handle = setInterval(fn, ms);
            handle.unref?.();
            clock.intervals.add(handle);
            return handle;
        },
        clearInterval: (handle) => {
            clock.intervals.delete(handle);
            clearInterval(handle);
        },
    };

    const context = {
        document: dom.document,
        window: dom.window,
        location: dom.location,
        Node: dom.Node,
        Text: dom.Text,
        fetch: createFetchStub(routes, { onRequest: (call) => requests.push(call) }),
        console,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
        // Not used by app.js, but present so an accidental reference fails loudly
        // as "not a function" rather than as "undefined is not an object".
        alert: () => { throw new Error('app.js must not use alert()'); },
        confirm: () => true,
        URL,
        Date,
        Math,
        JSON,
        Number,
        String,
        Boolean,
        Object,
        Array,
        Promise,
        Map,
        Set,
        Error,
    };
    context.globalThis = context;
    dom.window.document = dom.document;
    dom.window.location = dom.location;
    dom.window.setInterval = clock.setInterval;
    dom.window.clearInterval = clock.clearInterval;

    const sandbox = vm.createContext(context);
    // Parsing happens here; a syntax error throws and fails the test.
    const script = new vm.Script(appSource, { filename: 'public/app.js' });
    script.runInContext(sandbox);

    // app.js calls bootstrap() at the end, which is async: let its microtasks and
    // the fetch stubs settle before asserting on the rendered DOM.
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    for (const handle of clock.intervals) clearInterval(handle);

    return { ...dom, sandbox, requests, app: dom.app };
}

test('public/app.js parses as valid JavaScript', () => {
    // The whole point: a syntax error must fail here, not in the user's browser.
    assert.doesNotThrow(() => new vm.Script(appSource, { filename: 'public/app.js' }),
        'public/app.js 必须能被 JavaScript 解析器接受');
});

test('public/app.js avoids unreadable closing-bracket runs', () => {
    // A cheap guard on the exact shape that caused the escape: six or more closing
    // parentheses in a row is where a miscount hides without being obvious. Five is
    // the normal depth of this file's card > table > tbody > map > row nesting and
    // is allowed; the fix for a longer run is a named intermediate, not re-counting.
    const lines = appSource.split('\n');
    const offenders = [];
    lines.forEach((line, index) => {
        const runs = line.match(/\){6,}/g);
        if (runs) offenders.push(`${index + 1}: ${line.trim().slice(0, 80)}`);
    });
    assert.deepEqual(offenders, [],
        `出现 6 个以上连续右括号，极易数错；请改用具名中间变量:\n${offenders.join('\n')}`);
});

test('the front end executes and renders the first-run setup screen', async () => {
    const app = await runApp({
        routes: {
            'GET /api/session': { body: { data: { setupComplete: false, authenticated: false, csrfToken: null } } },
        },
    });
    const text = app.app.textContent;
    assert.match(text, /创建管理员|初始化/, `期望渲染出首次初始化界面，实际渲染: ${text.slice(0, 200)}`);
    assert.ok(app.requests.some((call) => call.path === '/api/session'), '启动时读取 /api/session');
    // The setup screen must actually contain inputs, not just a heading.
    assert.ok(app.app.querySelectorAll('input').length >= 2, '初始化界面包含输入框');
});

test('the front end renders the login screen when setup is done', async () => {
    const app = await runApp({
        routes: {
            'GET /api/session': { body: { data: { setupComplete: true, authenticated: false, csrfToken: null } } },
        },
    });
    const text = app.app.textContent;
    assert.match(text, /登录/, `期望渲染出登录界面，实际渲染: ${text.slice(0, 200)}`);
    assert.ok(app.app.querySelectorAll('input').length >= 2, '登录界面包含用户名与密码输入框');
});

test('a failed session read renders a retry screen instead of a blank page', async () => {
    const app = await runApp({ routes: {} });  // every route 404s
    const text = app.app.textContent;
    assert.match(text, /无法连接|重试/, `失败时应给出可操作提示，实际渲染: ${text.slice(0, 200)}`);
});

test('the signed-in shell renders with every navigation entry', async () => {
    const session = {
        setupComplete: true,
        authenticated: true,
        csrfToken: 'csrf-token-for-test',
        user: { id: 1, username: 'admin', role: 'owner' },
    };
    const app = await runApp({
        routes: {
            'GET /api/session': { body: { data: session } },
            'GET /api/dashboard': {
                body: {
                    data: {
                        counts: { total: 2, running: 1, stopped: 1, failed: 0 },
                        mappings: [
                            {
                                id: 1, name: 'oku-1', localPort: 25000, targetHost: 'www.okuapi.xyz',
                                targetPort: 9901, state: 'running', pid: 123, hasPassword: true, profile: 'default',
                            },
                            {
                                id: 2, name: 'oku-2', localPort: 25001, targetHost: 'www.okuapi.xyz',
                                targetPort: 9902, state: 'stopped', pid: null, hasPassword: false, profile: 'default',
                            },
                        ],
                        events: [{ id: 1, kind: 'mapping.started', detail: 'pid=123', actor: 'admin', at: Date.now() }],
                        localPortRange: [25000, 25999],
                        gatewayBinaryFound: true,
                    },
                },
            },
            'GET /api/events': { body: { data: [] } },
            'GET /api/mappings': { body: { data: [] } },
            'GET /api/users': { body: { data: [] } },
            'GET /api/diagnostics': { body: { data: null } },
        },
    });
    const text = app.app.textContent;
    // The shell must at minimum show the account and the navigation surface.
    assert.match(text, /admin/, `登录后应显示当前账户，实际渲染: ${text.slice(0, 300)}`);
    for (const label of ['总览', '端口映射', '事件记录']) {
        assert.ok(text.includes(label), `导航应包含「${label}」，实际渲染: ${text.slice(0, 400)}`);
    }
    // The old two-entity navigation is gone.
    assert.equal(text.includes('房间服务器'), false, '导航不应再有「房间服务器」');
    assert.ok(app.app.querySelectorAll('button').length >= 3, 'shell 应渲染出操作按钮');
});

test('every view function can be called without throwing', async () => {
    // Rendering each view against empty data catches a broken function that the
    // bootstrap path alone would never reach (the bug class that shipped).
    const session = {
        setupComplete: true, authenticated: true, csrfToken: 't',
        user: { id: 1, username: 'admin', role: 'owner' },
    };
    const app = await runApp({
        routes: {
            'GET /api/session': { body: { data: session } },
            'GET /api/dashboard': { body: { data: { counts: { total: 0, running: 0, stopped: 0, failed: 0 }, mappings: [], events: [], localPortRange: [25000, 25999], gatewayBinaryFound: false } } },
            'GET /api/mappings': { body: { data: [] } },
            'GET /api/users': { body: { data: [] } },
            'GET /api/events': { body: { data: [] } },
            'GET /api/diagnostics': { body: { data: { datasource: 'sqlite', localPortRange: [25000, 25999], usedLocalPorts: [], nodeVersion: 'v22.20.0' } } },
        },
    });

    const views = ['viewDashboard', 'viewMappings', 'viewEvents', 'viewUsers', 'viewSettings'];
    for (const name of views) {
        assert.equal(typeof app.sandbox[name], 'function', `${name} 应存在`);
    }
    // Render each one into a scratch container, the way navigation does.
    for (const name of views) {
        const target = app.document.createElement('div');
        await assert.doesNotReject(
            async () => { await app.sandbox[name](target); },
            `${name} 在空数据下不应抛错`,
        );
        assert.ok(target.childNodes.length > 0, `${name} 应渲染出内容`);
    }
});

test('the About card names the author and links the repository', async () => {
    const session = {
        setupComplete: true, authenticated: true, csrfToken: 't',
        user: { id: 1, username: 'admin', role: 'owner' },
    };
    const app = await runApp({
        routes: {
            'GET /api/session': { body: { data: session } },
            'GET /api/about': {
                body: {
                    data: {
                        name: 'MHXX/MHGU 网关批量管理控制台',
                        version: '0.1.0',
                        author: '小忆',
                        qq: '1726956536',
                        qqGroup: '741115244',
                        repo: 'https://github.com/caaaaaaaaaaaat/mhg-gateway-admin',
                        license: 'GPL-3.0-or-later',
                    },
                },
            },
            'GET /api/diagnostics': {
                body: {
                    data: {
                        datasource: 'sqlite', localPortRange: [25000, 25999],
                        usedLocalPorts: [], nodeVersion: 'v22.20.0',
                    },
                },
            },
        },
    });
    const target = app.document.createElement('div');
    await app.sandbox.viewSettings(target);
    const text = target.textContent;
    assert.match(text, /小忆/, '作者');
    assert.match(text, /1726956536/, 'QQ');
    assert.match(text, /741115244/, 'QQ 群');
    assert.match(text, /0\.1\.0/, '版本来后端');
    const link = [...target.querySelectorAll('a')]
        .find((node) => String(node.getAttribute('href') ?? '').includes('mhg-gateway-admin'));
    assert.ok(link, '仓库链接存在');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.match(String(link.getAttribute('rel') ?? ''), /noopener/, '外链带 noopener');
});

test('non-owner accounts do not get destructive controls', async () => {
    const session = {
        setupComplete: true, authenticated: true, csrfToken: 't',
        user: { id: 2, username: 'reader', role: 'viewer' },
    };
    const app = await runApp({
        routes: {
            'GET /api/session': { body: { data: session } },
            'GET /api/mappings': {
                body: {
                    data: [{
                        id: 1, name: 'oku-1', localPort: 25000, targetHost: 'www.okuapi.xyz',
                        targetPort: 9901, state: 'stopped', pid: null, hasPassword: false, profile: 'default',
                    }],
                },
            },
            'GET /api/events': { body: { data: [] } },
            'GET /api/dashboard': { body: { data: { counts: { total: 0, running: 0, stopped: 0, failed: 0 }, mappings: [], events: [], localPortRange: [25000, 25999], gatewayBinaryFound: false } } },
        },
    });
    const target = app.document.createElement('div');
    await app.sandbox.viewMappings(target);
    const text = target.textContent;
    assert.match(text, /oku-1/, 'viewer 仍能看到映射列表');
    assert.match(text, /25000/, 'viewer 能看到本地端口');

    // Destructive controls are buttons, so assert on the button surface rather than
    // the whole text: the page's own hint text mentions "批量启动" too.
    const buttonLabels = [...target.querySelectorAll('button')].map((node) => node.textContent.trim());
    for (const forbidden of ['新建映射', '批量启动', '批量停止', '删除', '编辑']) {
        assert.equal(
            buttonLabels.some((label) => label === forbidden || label.includes(forbidden)),
            false,
            `viewer 不应看到「${forbidden}」按钮，实际按钮: ${JSON.stringify(buttonLabels)}`,
        );
    }
    // Reading a log is not destructive, so it stays available.
    assert.ok(buttonLabels.some((label) => label.includes('日志')), 'viewer 仍可查看日志');
});

test('index.html and app.js agree on what the shell provides', () => {
    // The page must load the exact files that exist, and the module must find the
    // mount point it depends on. A rename on either side breaks the page silently.
    assert.match(indexSource, /<div id="app"/);
    assert.match(indexSource, /src="\/app\.js"/);
    assert.match(indexSource, /href="\/app\.css"/);
    assert.match(indexSource, /type="module"/);
    assert.ok(appSource.includes("getElementById('app')") || appSource.includes('getElementById("app")'),
        'app.js 应通过 #app 挂载');
});

test('app.css defines every class the module actually renders', () => {
    // A class the JS uses but the CSS never defines renders unstyled, which looks
    // like a broken page even though nothing throws.
    const used = new Set();
    for (const match of appSource.matchAll(/(?:class:\s*'|className\s*=\s*')([^']+)'/g)) {
        for (const name of match[1].split(/\s+/)) {
            if (name && /^[a-z][a-z0-9-]*$/.test(name)) used.add(name);
        }
    }
    const missing = [...used].filter((name) => !cssSource.includes(`.${name}`));
    assert.deepEqual(missing, [], `这些 class 在 app.js 中使用但 app.css 未定义: ${missing.join(', ')}`);
});
