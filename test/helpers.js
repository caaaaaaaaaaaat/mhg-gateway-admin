// SPDX-License-Identifier: GPL-3.0-or-later
// Shared test helpers: build an app on an ephemeral port with an in-memory
// SQLite datasource and a stub gateway binary, so the API tests exercise the real
// server without touching the network beyond loopback.

import { createServer as createNetServer } from 'node:net';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { SqliteDatasource } from '../src/datasource/sqlite.js';
import { GatewaySupervisor } from '../src/lib/supervisor.js';
import { validateConfig, defaultConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';

/** Find a free TCP port by binding to 0 and reading back the assignment. */
export function freePort() {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/** A config object with everything pointed at temporary paths. */
export function testConfig(overrides = {}) {
    const root = mkdtempSync(join(tmpdir(), 'mhga-test-'));
    const config = validateConfig({
        ...defaultConfig(),
        // Port 1 is a placeholder; startTestApp() always listens on an ephemeral
        // port via server.listen(0), so this value is only a validated default.
        server: { host: '127.0.0.1', port: 1, publicUrl: '', trustProxy: false },
        auth: {
            cookieName: 'mhga_test_session',
            sessionTtlHours: 1,
            sessionMaxDays: 1,
            passwordMinLength: 8,
            maxFailedLogins: 3,
            lockoutMinutes: 1,
            secretFile: 'session-secret',
            secureCookies: false,
        },
        storage: { driver: 'sqlite', sqlite: { path: ':memory:' } },
        gateways: {
            binaryPath: '',
            binSearchPaths: ['bin'],
            // Only the LOCAL side has a pool; the upstream port is typed per mapping.
            localPortRange: [26000, 26010],
            runtimeDir: 'rooms',
            extraArgs: [],
            sampleIntervalMs: 60_000,
            logRetentionDays: 1,
        },
        logging: { level: 'error', file: '' },
        ...overrides,
    }, { root });
    config.version = 'test';
    config._tmpRoot = root;
    return config;
}

/**
 * Start the app. Returns handles plus a `request()` helper that keeps cookies and
 * the CSRF token, which is what the browser does.
 */
export async function startTestApp({ config = testConfig(), spawnImpl = stubSpawn() } = {}) {
    const logger = createLogger({ level: 'error' });
    const datasource = new SqliteDatasource({ path: config.storage.sqlite.path });
    await datasource.init();
    const supervisor = new GatewaySupervisor({
        config,
        datasource,
        logger,
        // The stub gateway is a .js file, so spawning it goes through `node`.
        // Passing this as the default means a test can install a stub binary and
        // immediately start it, which is what the end-to-end stories do.
        spawnImpl,
    });
    // Skip supervisor.start(): that timer is not needed in tests and would keep
    // the event loop busy. Binary probing is what startRoom depends on.
    supervisor.probeBinary();

    const { server, auth } = createApp({ config, datasource, supervisor, logger });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    /** Cookie-jar aware fetch. */
    const jar = new Map();
    const request = async (path, { method = 'GET', body, csrf = true, headers = {} } = {}) => {
        const finalHeaders = { Accept: 'application/json', ...headers };
        const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
        if (cookie) finalHeaders.Cookie = cookie;
        if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
        // `csrf: false` must mean "send no token at all", even for a signed-in
        // session; an explicit header in `headers` wins so a test can send a wrong
        // token deliberately.
        const hasExplicitCsrf = Object.keys(headers).some((key) => key.toLowerCase() === 'x-csrf-token');
        if (csrf && !hasExplicitCsrf && client.session?.csrfToken && method !== 'GET') {
            finalHeaders['x-csrf-token'] = client.session.csrfToken;
        }
        const response = await fetch(`${base}${path}`, {
            method,
            headers: finalHeaders,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const setCookie = response.headers.getSetCookie?.() ?? [];
        for (const line of setCookie) {
            const [pair] = line.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1).trim();
            if (value === '') jar.delete(name);
            else jar.set(name, value);
        }
        const text = await response.text();
        let payload = null;
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch {
                payload = { raw: text };
            }
        }
        return { status: response.status, headers: response.headers, body: payload };
    };

    const client = {
        base,
        jar,
        request,
        session: null,
        /** Complete first-run setup and sign in. */
        async login({ username = 'admin', password = 'Test-Password-123' } = {}) {
            const setup = await request('/api/setup', {
                method: 'POST',
                body: { username, password, confirm: password },
            });
            if (setup.status !== 201) throw new Error(`setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
            const signIn = await request('/api/login', { method: 'POST', body: { username, password } });
            if (signIn.status !== 200) throw new Error(`login failed: ${signIn.status} ${JSON.stringify(signIn.body)}`);
            client.session = signIn.body.data;
            return client.session;
        },
        /**
         * Create a mapping through the real API: one local port paired with one
         * upstream room server. Ports are left blank by default so the pool assigns
         * a distinct one per call.
         */
        async createMapping(overrides = {}) {
            const response = await request('/api/mappings', {
                method: 'POST',
                body: {
                    name: `map-${Math.random().toString(36).slice(2, 8)}`,
                    targetHost: '127.0.0.1',
                    targetPort: 24872,
                    ...overrides,
                },
            });
            if (response.status !== 201) {
                throw new Error(`createMapping failed: ${response.status} ${JSON.stringify(response.body)}`);
            }
            return response.body.data;
        },
    };

    return {
        base,
        config,
        datasource,
        supervisor,
        server,
        client,
        async close() {
            await new Promise((resolve) => server.close(resolve));
            await supervisor.stop();
            await datasource.close();
            // `_keepRoot` lets a test share one temp root across two app sessions
            // (the persistence story), so the cleanup is opt-out.
            if (config._keepRoot) return;
            try {
                rmSync(config._tmpRoot, { recursive: true, force: true });
            } catch { /* best effort */ }
        },
    };
}

/**
 * Write a tiny script that stands in for citra-gateway. Node is used so the test
 * does not depend on a built C++ binary, while still exercising the real spawn,
 * pipe, log rotation and exit paths.
 *
 * Behaviour is chosen by an argument appended in extraArgs:
 *   --stub-run     stay alive until SIGTERM
 *   --stub-exit    exit immediately with code 3
 *   --stub-echo    print a line then stay alive
 */
export function writeStubBinary(dir, name = 'citra-gateway-stub.js') {
    // The caller may point this at a directory that does not exist yet (a runtime
    // dir that has never been written to); creating it here keeps the helper a
    // single call instead of a mkdir dance at every call site.
    mkdirSync(dir, { recursive: true });
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--stub-')) ?? '--stub-run';
if (mode === '--stub-echo') {
    process.stdout.write('gateway listening on ' + (args[args.indexOf('--listen') + 1] ?? '?') + '\\n');
}
if (mode === '--stub-exit') {
    process.stderr.write('stub exiting\\n');
    process.exit(3);
}
if (mode === '--stub-status') {
    // Mimic the real per-second status line, which is what carries the capacity the
    // room reported (slots) and the current occupancy (members).
    process.stdout.write('t=1s clients=0 accepted=0 joined=0 slots=4 members=2 frames_in=0 forwarded=0 rejected=0\\n');
}
const keep = setInterval(() => {}, 1000);
process.on('SIGTERM', () => { clearInterval(keep); process.exit(0); });
`;
    const path = join(dir, name);
    writeFileSync(path, script, 'utf8');
    try {
        chmodSync(path, 0o755);
    } catch { /* Windows */ }
    return path;
}

/** A spawn implementation that runs the stub script with the node executable. */
export function stubSpawn() {
    return (binary, args, options) => {
        // Re-enter through node so a .js stub is executable on every platform.
        return realSpawn(process.execPath, [binary, ...args], options);
    };
}
