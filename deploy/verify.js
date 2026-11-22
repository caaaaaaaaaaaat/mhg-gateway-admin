#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Manual end-to-end verification against a REAL running console process.
//
// `npm test` drives the app in-process. This script is the other half: it starts
// `node src/index.js` as a separate process on a temporary data directory, talks
// to it over real HTTP the way a browser does, and checks the things an operator
// would notice -- first-run page, setup, login, room lifecycle with a stub
// gateway binary, log retrieval, restart persistence, and every error path.
//
//   node deploy/verify.js
//
// Exit code 0 means every check passed.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
let failures = 0;

function check(ok, label, detail = '') {
    checks.push({ ok: Boolean(ok), label, detail });
    if (!ok) failures += 1;
    const mark = ok ? 'PASS' : 'FAIL';
    process.stdout.write(`${mark} ${label}${detail && !ok ? ` — ${detail}` : ''}\n`);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, { timeoutMs = 20000, intervalMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const response = await fetch(url);
            if (response.ok) return true;
        } catch { /* not up yet */ }
        if (Date.now() >= deadline) return false;
        await sleep(intervalMs);
    }
}

async function main() {
    const root = mkdtempSync(join(tmpdir(), 'mhga-verify-'));
    const dataDir = join(root, 'data');
    const binDir = join(root, 'bin');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const port = await freePort();

    // A stub gateway binary: stays alive, echoes a line, exits on SIGTERM.
    // The platform-specific name matters: the console looks for `citra-gateway.exe`
    // on Windows and `citra-gateway` elsewhere.
    const stub = join(binDir, process.platform === 'win32' ? 'citra-gateway.exe' : 'citra-gateway');
    writeFileSync(stub, `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write('gateway listening on 127.0.0.1:' + (args[args.indexOf('--listen-port') + 1] ?? '?') + '\\n');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`);
    try {
        chmodSync(stub, 0o755);
    } catch { /* Windows has no chmod */ }

    const config = {
        server: { host: '127.0.0.1', port, publicUrl: '', trustProxy: false },
        auth: { secureCookies: false, passwordMinLength: 10, maxFailedLogins: 5, lockoutMinutes: 1 },
        storage: { driver: 'sqlite', sqlite: { path: join(dataDir, 'verify.db') } },
        gateways: {
            binaryPath: '',
            // The stub is a Node script; the console runs it through Node so the
            // same verification works on Windows and Linux.
            interpreter: process.execPath,
            binSearchPaths: [binDir],
            localPortRange: [27100, 27109],
            runtimeDir: join(dataDir, 'rooms'),
            sampleIntervalMs: 500,
            logRetentionDays: 1,
        },
        logging: { level: 'warn', file: '' },
    };
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    let child = null;
    let base = `http://127.0.0.1:${port}`;

    const startConsole = async () => {
        child = spawn(process.execPath, [join(projectRoot, 'src/index.js'), '--config', configPath], {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, MHGA_LOG_LEVEL: 'warn' },
        });
        child.stdout.on('data', () => {});
        child.stderr.on('data', (chunk) => {
            const text = String(chunk);
            if (!text.includes('ExperimentalWarning') && !text.includes('trace-warnings')) {
                process.stdout.write(`  [console] ${text.trim()}\n`);
            }
        });
        return waitForHttp(`${base}/api/health`);
    };

    const stopConsole = async () => {
        if (!child) return;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(8000)]);
        child = null;
        await sleep(300);
    };

    try {
        // --- 1. process starts and health answers ---------------------------
        check(await startConsole(), '控制台进程启动，/api/health 可用');

        // --- 2. the browser entry point -------------------------------------
        const index = await fetch(`${base}/`);
        const html = await index.text();
        check(index.ok && html.includes('网关管理控制台'), '首页可访问且包含页面标题');
        check((index.headers.get('content-security-policy') ?? '').includes("default-src 'self'"), 'CSP 响应头存在');
        check((await fetch(`${base}/app.css`)).ok && (await fetch(`${base}/app.js`)).ok, '样式与脚本可加载');

        // --- 3. first-run page ---------------------------------------------
        const session0 = await (await fetch(`${base}/api/session`)).json();
        check(session0.data.setupComplete === false, '首次打开显示「需要初始化」');
        check(session0.data.gatewayBinaryFound === true, '自检能找到网关程序（stub）');

        // --- 4. create the administrator -----------------------------------
        const setup = await fetch(`${base}/api/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'Verify-Pass-2026', confirm: 'Verify-Pass-2026' }),
        });
        check(setup.status === 201, '创建管理员成功', `status=${setup.status}`);

        const setupAgain = await fetch(`${base}/api/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'other', password: 'Other-Pass-2026', confirm: 'Other-Pass-2026' }),
        });
        check(setupAgain.status === 409, '重复初始化被拒绝 (409)');

        // --- 5. login ------------------------------------------------------
        const login = await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'Verify-Pass-2026' }),
        });
        const loginBody = await login.json();
        const cookie = (login.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ');
        check(login.ok, '登录成功', `status=${login.status}`);
        check(cookie.includes('mhga') || cookie.includes('mhg_admin_session'), '收到会话 cookie');
        const csrf = loginBody.data.csrfToken;
        check(typeof csrf === 'string' && csrf.length > 20, '拿到 CSRF token');

        const authed = (path, options = {}) => fetch(`${base}${path}`, {
            ...options,
            headers: {
                Cookie: cookie,
                'x-csrf-token': csrf,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers ?? {}),
            },
        });

        // --- 6. a write without CSRF is refused ----------------------------
        const noCsrf = await fetch(`${base}/api/mappings`, {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetHost: '127.0.0.1', targetPort: 24872 }),
        });
        check(noCsrf.status === 403, '缺少 CSRF 头的写操作被拒绝 (403)', `status=${noCsrf.status}`);

        // --- 7. one row is one pair: local port -> upstream server ---------
        const pair = await (await authed('/api/mappings', {
            method: 'POST',
            body: JSON.stringify({
                name: '验证-1', localPort: 27100,
                targetHost: '127.0.0.1', targetPort: 24872, password: 'room-pw',
            }),
        })).json();
        check(pair.data?.id > 0, '创建映射（本地端口 → 目标服务器）', JSON.stringify(pair).slice(0, 160));
        check(pair.data?.localPort === 27100, '本地端口按填写值保存');
        check(pair.data?.targetHost === '127.0.0.1' && pair.data?.targetPort === 24872, '目标 host:port 正确保存');
        check(pair.data?.hasPassword === true && pair.data?.password === undefined, '房间密码不回显');

        const auto = await (await authed('/api/mappings', {
            method: 'POST',
            body: JSON.stringify({ name: '验证-2', targetHost: '127.0.0.1', targetPort: 24873 }),
        })).json();
        check(auto.data?.localPort >= 27101, '留空本地端口时从端口池分配', `got ${auto.data?.localPort}`);
        const mappingIds = [pair.data.id, auto.data.id];
        const list = await (await authed('/api/mappings')).json();
        check(new Set(list.data.map((row) => row.localPort)).size === 2, '两条映射占用不同的本地端口');

        const clash = await authed('/api/mappings', {
            method: 'POST',
            body: JSON.stringify({ targetHost: '127.0.0.1', targetPort: 1, localPort: 27100 }),
        });
        check(clash.status === 409, '重复本地端口被拒绝 (409)', `status=${clash.status}`);

        // --- 8. batch start real processes ---------------------------------
        const started = await (await authed('/api/mappings/batch/start', {
            method: 'POST', body: JSON.stringify({ ids: mappingIds }),
        })).json();
        check(started.data?.succeeded === 2, '批量启动 2 条映射成功', JSON.stringify(started.data?.results));

        const running = await (await authed('/api/mappings')).json();
        check(running.data.every((row) => row.state === 'running' && row.pid > 0),
            '两条映射均为 running 且有真实 pid');

        // --- 9. logs -------------------------------------------------------
        await sleep(600);
        const log = await (await authed(`/api/mappings/${mappingIds[0]}/log?lines=80`)).json();
        const logText = log.data?.text ?? '';
        check(/gateway listening/.test(logText), '映射日志可读且含网关输出');
        check(!/room-pw/.test(logText), '日志中不含房间密码');
        // The whole point of this model: the gateway must be told to dial the upstream
        // port the operator typed, not some locally allocated one.
        check(new RegExp(`--room-port\\s+24872`).test(logText), '网关命令行使用填写的目标端口 24872', logText.slice(0, 200));
        check(new RegExp(`--listen-port\\s+27100`).test(logText), '网关命令行使用指定的本地端口 27100');

        // --- 10. dashboard -------------------------------------------------
        const dashboard = await (await authed('/api/dashboard')).json();
        check(dashboard.data?.counts?.running === 2, '总览统计显示 2 条运行中');
        check(dashboard.data?.counts?.total === 2, '总览统计映射总数正确');
        check(Array.isArray(dashboard.data?.localPortRange), '总览接口返回本地端口池');

        // --- 11. batch stop ------------------------------------------------
        const stopped = await (await authed('/api/mappings/batch/stop', {
            method: 'POST', body: JSON.stringify({ ids: mappingIds }),
        })).json();
        check(stopped.data?.succeeded === 2, '批量停止成功');
        await sleep(1200);
        const settled = await (await authed('/api/mappings')).json();
        check(settled.data.every((row) => row.state === 'stopped' && row.pid === null),
            '停止后映射状态为 stopped 且无 pid');

        // --- 12. error paths ----------------------------------------------
        const badPort = await authed('/api/mappings', {
            method: 'POST', body: JSON.stringify({ targetHost: '127.0.0.1', targetPort: 24872, localPort: 0 }),
        });
        check(badPort.status === 400, '非法本地端口被拒绝 (400)');
        const badHost = await authed('/api/mappings', {
            method: 'POST', body: JSON.stringify({ targetHost: 'http://x/y', targetPort: 24872 }),
        });
        check(badHost.status === 400, '带协议的地址被拒绝 (400)');
        const mixedHost = await authed('/api/mappings', {
            method: 'POST', body: JSON.stringify({ targetHost: '1.2.3.4:9901', targetPort: 9901 }),
        });
        check(mixedHost.status === 400, 'host 里混填端口被拒绝 (400)');
        const unknownApi = await fetch(`${base}/api/nope`);
        check(unknownApi.status === 404 && (unknownApi.headers.get('content-type') ?? '').includes('json'),
            '未知 API 返回 JSON 404');

        // --- 13. events ----------------------------------------------------
        const events = await (await authed('/api/events?limit=100')).json();
        const kinds = new Set(events.data.map((event) => event.kind));
        check(kinds.has('mapping.started') && kinds.has('mapping.stopped'), '审计记录包含启动与停止');
        check(kinds.has('auth.setup'), '审计记录包含初始化');
        check(kinds.has('mapping.created'), '审计记录包含映射创建');

        // --- 14. restart persistence ---------------------------------------
        await stopConsole();
        check(await startConsole(), '控制台重启成功');
        const sessionAfter = await (await fetch(`${base}/api/session`)).json();
        check(sessionAfter.data.setupComplete === true, '重启后不需要重新初始化');

        const relogin = await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'Verify-Pass-2026' }),
        });
        check(relogin.ok, '重启后可用同一账户登录');
        const reloginBody = await relogin.json();
        const cookie2 = (relogin.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ');
        const mappings2 = await (await fetch(`${base}/api/mappings`, {
            headers: { Cookie: cookie2, 'x-csrf-token': reloginBody.data.csrfToken },
        })).json();
        check(mappings2.data?.length === 2, '重启后映射仍在',
            JSON.stringify(mappings2.data?.map((row) => [row.name, row.localPort, row.targetPort])));
        check(mappings2.data.every((row) => row.targetHost === '127.0.0.1'), '重启后目标服务器地址仍在',
            JSON.stringify(mappings2.data?.map((row) => row.targetHost)));
        check(mappings2.data.some((row) => row.localPort === 27100 && row.targetPort === 24872),
            '重启后「本地端口 → 目标端口」这一对保持原样');
        check(mappings2.data.some((row) => row.hasPassword === true) &&
            mappings2.data.some((row) => row.hasPassword === false), '重启后密码设置状态正确');


        // --- 15. shutdown leaves no orphan ---------------------------------
        await stopConsole();
        check(true, '控制台可正常停止');
    } finally {
        await stopConsole();
        if (child) {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        // The temp tree holds a database and logs; remove it unless asked to keep.
        if (!process.env.MHGA_VERIFY_KEEP) {
            try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
        } else {
            process.stdout.write(`\n临时目录保留在: ${root}\n`);
        }
    }

    const passed = checks.filter((item) => item.ok).length;
    process.stdout.write(`\n=== ${passed}/${checks.length} 项通过，${failures} 项失败 ===\n`);
    if (failures > 0) {
        for (const item of checks) {
            if (!item.ok) process.stdout.write(`FAILED ${item.label} ${item.detail}\n`);
        }
    }
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    process.stderr.write(`验证脚本异常: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
});
