// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end walkthroughs: the flows a first-time user actually performs, driven
// through the HTTP API exactly as the browser does.
//
// These are deliberately *not* unit tests of one function. Each test follows one
// operator story from an empty database to the expected end state, so a broken
// link anywhere in the chain shows up as a failing story.
//
// The model under test: one mapping is one pair, a local port players connect to
// forwarded to one upstream room server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, writeStubBinary, testConfig } from './helpers.js';

test('story: first-time user sets up, then maps two local ports to two servers', async () => {
    const app = await startTestApp();
    try {
        // 1. The very first page load says "set up an admin".
        const initial = await app.client.request('/api/session');
        assert.equal(initial.body.data.setupComplete, false);

        // 2. The user creates the account, then signs in.
        const setup = await app.client.request('/api/setup', {
            method: 'POST',
            body: { username: 'owner', password: 'My-Strong-Pass-1', confirm: 'My-Strong-Pass-1' },
        });
        assert.equal(setup.status, 201);
        const login = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'owner', password: 'My-Strong-Pass-1' },
        });
        assert.equal(login.status, 200);
        app.client.session = login.body.data;

        // 3. The operator's actual job: pair ports with servers.
        const first = (await app.client.request('/api/mappings', {
            method: 'POST',
            body: {
                name: 'oku-1', localPort: 26000,
                targetHost: 'www.okuapi.xyz', targetPort: 9901, password: 'pw1',
            },
        })).body.data;
        const second = (await app.client.request('/api/mappings', {
            method: 'POST',
            body: {
                name: 'oku-2', localPort: 26001,
                targetHost: 'www.okuapi.xyz', targetPort: 9902, password: 'pw2',
            },
        })).body.data;

        // Each row is one pair, and the two rows point at different upstream ports
        // on the same host -- the reason a "server" entity would have been in the way.
        assert.equal(first.localPort, 26000);
        assert.equal(first.targetHost, 'www.okuapi.xyz');
        assert.equal(first.targetPort, 9901);
        assert.equal(second.localPort, 26001);
        assert.equal(second.targetPort, 9902);
        assert.equal(first.targetHost, second.targetHost);

        // 4. The dashboard reflects reality before anything is started.
        const before = await app.client.request('/api/dashboard');
        assert.equal(before.body.data.counts.total, 2);
        assert.equal(before.body.data.counts.running, 0);
        assert.equal(before.body.data.counts.stopped, 2);
        assert.equal(before.body.data.gatewayBinaryFound, false, 'no binary is configured in this test');

        // 5. Starting without a gateway binary is an honest, actionable failure that
        //    names the missing program.
        const start = await app.client.request(`/api/mappings/${first.id}/start`, { method: 'POST' });
        assert.equal(start.status, 409);
        assert.match(start.body.error.message, /找不到 citra-gateway/);

        // 6. The failure is visible where the operator will look for it.
        const after = await app.client.request('/api/mappings');
        const row = after.body.data.find((item) => item.id === first.id);
        assert.equal(row.state, 'failed');
        assert.match(row.failure, /找不到 citra-gateway/);

        // 7. And it is in the audit trail, attributed to the account that asked.
        const events = await app.client.request('/api/events?limit=50');
        const refusal = events.body.data.find((event) => event.kind === 'mapping.start.refused');
        assert.ok(refusal);
        assert.equal(refusal.actor, 'owner');
    } finally {
        await app.close();
    }
});

test('story: operator starts real processes, reads a log, then stops them in bulk', async () => {
    const app = await startTestApp();
    try {
        const binary = writeStubBinary(app.config.gateways.runtimeDir, 'citra-gateway');
        app.supervisor.binary = binary;
        app.supervisor.binaryError = '';

        await app.client.login();
        const mappings = [];
        for (const name of ['实战-1', '实战-2', '实战-3']) {
            mappings.push((await app.client.request('/api/mappings', {
                method: 'POST',
                body: { name, targetHost: '10.0.0.5', targetPort: 24872 },
            })).body.data);
        }

        // Batch start: every mapping must reach `running` with a live pid.
        const started = await app.client.request('/api/mappings/batch/start', {
            method: 'POST', body: { ids: mappings.map((row) => row.id) },
        });
        assert.equal(started.status, 200);
        assert.equal(started.body.data.succeeded, 3, JSON.stringify(started.body.data.results));

        const running = await app.client.request('/api/mappings');
        for (const mapping of mappings) {
            const current = running.body.data.find((item) => item.id === mapping.id);
            assert.equal(current.state, 'running', `${mapping.name} should be running`);
            assert.ok(current.pid > 0, `${mapping.name} should report a pid`);
        }

        // The log endpoint returns the launched command line with the password
        // redacted, and the upstream address the operator configured.
        const log = await app.client.request(`/api/mappings/${mappings[0].id}/log?lines=50`);
        assert.equal(log.status, 200);
        assert.match(log.body.data.text, /start /);
        assert.match(log.body.data.text, /--room/);
        assert.match(log.body.data.text, /10\.0\.0\.5/);

        // Batch stop returns everything to `stopped`.
        const stopped = await app.client.request('/api/mappings/batch/stop', {
            method: 'POST', body: { ids: mappings.map((row) => row.id) },
        });
        assert.equal(stopped.body.data.succeeded, 3);
        const settled = await Promise.all(mappings.map(async (mapping) => {
            for (let attempt = 0; attempt < 60; attempt += 1) {
                const list = await app.client.request('/api/mappings');
                const current = list.body.data.find((item) => item.id === mapping.id);
                if (current.state === 'stopped') return current;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return null;
        }));
        for (const mapping of settled) {
            assert.ok(mapping, 'every mapping settles in stopped');
            assert.equal(mapping.pid, null);
        }
    } finally {
        await app.close();
    }
});

test('story: the same upstream server can back several local ports', async () => {
    // This is the arrangement a "one server entity + N rooms" model made awkward:
    // one room server, four local entry ports, each its own gateway process.
    const app = await startTestApp();
    try {
        await app.client.login();
        const created = [];
        for (let index = 0; index < 4; index += 1) {
            created.push((await app.client.request('/api/mappings', {
                method: 'POST',
                body: {
                    name: `公会${index + 1}`,
                    targetHost: 'room.example.com',
                    targetPort: 24872,
                },
            })).body.data);
        }
        assert.equal(new Set(created.map((row) => row.localPort)).size, 4, 'four distinct local ports');
        assert.ok(created.every((row) => row.targetHost === 'room.example.com' && row.targetPort === 24872),
            'all four forward to the same upstream server');

        const diagnostics = await app.client.request('/api/diagnostics');
        assert.equal(diagnostics.body.data.usedLocalPorts.length, 4);
        assert.equal(diagnostics.body.data.mappingCount, 4);
    } finally {
        await app.close();
    }
});

test('story: a viewer can audit the console but cannot change it', async () => {
    const app = await startTestApp();
    try {
        await app.client.login({ password: 'Owner-Password-123' });
        const mapping = await app.client.createMapping({ name: '只读映射' });
        await app.client.request('/api/users', {
            method: 'POST', body: { username: 'guest', password: 'Guest-Password-123', role: 'viewer' },
        });

        await app.client.request('/api/logout', { method: 'POST' });
        const viewerLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'guest', password: 'Guest-Password-123' },
        });
        app.client.session = viewerLogin.body.data;

        for (const path of ['/api/dashboard', '/api/mappings', '/api/events']) {
            const response = await app.client.request(path);
            assert.equal(response.status, 200, `${path} should be readable by a viewer`);
        }
        const log = await app.client.request(`/api/mappings/${mapping.id}/log?lines=10`);
        assert.equal(log.status, 200, 'the log is part of the read surface');

        const writes = [
            ['POST', '/api/mappings', { targetHost: '1.1.1.1', targetPort: 1 }],
            ['POST', `/api/mappings/${mapping.id}/start`, {}],
            ['POST', `/api/mappings/${mapping.id}/stop`, {}],
            ['POST', '/api/mappings/batch/start', { ids: [mapping.id] }],
            ['PATCH', `/api/mappings/${mapping.id}`, { name: 'x' }],
            ['DELETE', `/api/mappings/${mapping.id}`, undefined],
            ['POST', '/api/users', { username: 'y', password: 'Y-Password-1234' }],
        ];
        for (const [method, path, body] of writes) {
            const response = await app.client.request(path, { method, body });
            assert.equal(response.status, 403, `${method} ${path} must be refused, got ${response.status}`);
        }

        const diagnostics = await app.client.request('/api/diagnostics');
        assert.equal(diagnostics.status, 403, 'diagnostics are admin-only');
    } finally {
        await app.close();
    }
});

test('story: the console survives a restart with its mappings and accounts', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'mhga-persist-'));
    const dbPath = join(root, 'persist.db');
    // Both sessions share one on-disk database: the point is persistence across a
    // process restart, which an in-memory database cannot show.
    const configFor = () => {
        const base = testConfig();
        base.storage.sqlite.path = dbPath;
        base._tmpRoot = root;
        base._keepRoot = true;
        return base;
    };

    const app = await startTestApp({ config: configFor() });
    try {
        const binary = writeStubBinary(app.config.gateways.runtimeDir, 'citra-gateway');
        app.supervisor.binary = binary;
        app.supervisor.binaryError = '';
        await app.client.login({ password: 'Persist-Password-1' });
        const mapping = (await app.client.request('/api/mappings', {
            method: 'POST',
            body: {
                name: '持久映射', localPort: 26000,
                targetHost: 'www.okuapi.xyz', targetPort: 9901, password: 'keep-me',
            },
        })).body.data;
        await app.client.request(`/api/mappings/${mapping.id}/start`, { method: 'POST' });
    } finally {
        await app.close();
    }

    const reopened = await startTestApp({ config: configFor() });
    try {
        const anonymous = await reopened.client.request('/api/session');
        assert.equal(anonymous.body.data.setupComplete, true, 'setup is not repeated');

        const login = await reopened.client.request('/api/login', {
            method: 'POST', body: { username: 'admin', password: 'Persist-Password-1' },
        });
        assert.equal(login.status, 200, 'the account and password survive');
        reopened.client.session = login.body.data;

        const mappings = await reopened.client.request('/api/mappings');
        assert.equal(mappings.body.data.length, 1);
        const row = mappings.body.data[0];
        assert.equal(row.name, '持久映射');
        assert.equal(row.localPort, 26000, 'the local port is stable');
        assert.equal(row.targetHost, 'www.okuapi.xyz', 'the upstream host is stable');
        assert.equal(row.targetPort, 9901, 'the upstream port is stable');
        assert.equal(row.hasPassword, true, 'the upstream password is still set');

        // The console shut down gracefully, so the gateway was stopped on the way out
        // and the mapping is recorded as stopped. (A mapping left `running` by a crash
        // is a different path: supervisor.start() adopts it as failed so the operator
        // is told, covered by test/api.supervisor.test.js.)
        assert.equal(row.state, 'stopped');
        assert.equal(row.desiredState, 'stopped');
        assert.equal(row.pid, null);
    } finally {
        await reopened.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test('story: HTML, CSS and JS are servable and reference the mapping API', async () => {
    const app = await startTestApp();
    try {
        const index = await fetch(`${app.base}/`);
        const html = await index.text();
        assert.match(html, /<script src="\/app\.js" type="module">/);
        assert.match(html, /<link rel="stylesheet" href="\/app\.css">/);
        assert.match(html, /<div id="app"/);

        const css = await (await fetch(`${app.base}/app.css`)).text();
        for (const className of ['.topbar', '.auth-card', '.badge', '.table-wrap', '.toast', '.field', '.batch-bar']) {
            assert.ok(css.includes(className), `app.css must define ${className}`);
        }

        const js = await (await fetch(`${app.base}/app.js`)).text();
        for (const endpoint of [
            '/api/session', '/api/setup', '/api/login', '/api/logout', '/api/password',
            '/api/dashboard', '/api/mappings', '/api/users', '/api/events', '/api/diagnostics',
        ]) {
            assert.ok(js.includes(endpoint), `app.js must use ${endpoint}`);
        }
        // The old two-entity endpoints must be gone from the client too.
        assert.equal(js.includes('/api/rooms'), false, 'app.js must not call /api/rooms');
        assert.equal(js.includes('/api/servers'), false, 'app.js must not call /api/servers');
        assert.equal(/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(js), false,
            'the console must not reference external origins');
    } finally {
        await app.close();
    }
});
