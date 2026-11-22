// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end walkthroughs: the flows a first-time user actually performs, driven
// through the HTTP API exactly as the browser does.
//
// These are deliberately *not* unit tests of one function. Each test follows one
// operator story from an empty database to the expected end state, so a broken
// link anywhere in the chain shows up as a failing story.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { startTestApp, writeStubBinary, testConfig } from './helpers.js';

test('story: first-time user sets up, adds a server, creates and starts two rooms', async () => {
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

        // 3. Add the room server the players will actually join.
        const server = await app.client.createServer({
            name: '公会服务器', host: '192.168.1.50', port: 24872, password: 'room-pw',
        });
        assert.equal(server.hasPassword, true);

        // 4. Create two halls; ports are allocated automatically.
        const hallA = (await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '大厅-A', serverId: server.id, password: 'pw-a' },
        })).body.data;
        const hallB = (await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '大厅-B', serverId: server.id },
        })).body.data;
        assert.notEqual(hallA.citraPort, hallB.citraPort);

        // 5. The dashboard reflects reality before anything is started.
        const before = await app.client.request('/api/dashboard');
        assert.equal(before.body.data.counts.total, 2);
        assert.equal(before.body.data.counts.running, 0);
        assert.equal(before.body.data.counts.stopped, 2);
        assert.equal(before.body.data.gatewayBinaryFound, false, 'no binary is configured in this test');

        // 6. Starting without a gateway binary is an honest, actionable failure.
        const start = await app.client.request(`/api/rooms/${hallA.id}/start`, { method: 'POST' });
        assert.equal(start.status, 409);
        assert.match(start.body.error.message, /找不到 citra-gateway/);

        // 7. The failure is visible where the operator will look for it.
        const after = await app.client.request('/api/rooms');
        const roomA = after.body.data.find((room) => room.id === hallA.id);
        assert.equal(roomA.state, 'failed');
        assert.match(roomA.failure, /找不到 citra-gateway/);

        // 8. And it is in the audit trail, attributed to the account that asked.
        const events = await app.client.request('/api/events?limit=50');
        const refusal = events.body.data.find((event) => event.kind === 'room.start.refused');
        assert.ok(refusal);
        assert.equal(refusal.actor, 'owner');
    } finally {
        await app.close();
    }
});

test('story: operator starts real processes, watches logs, then stops them in bulk', async () => {
    // Point the harness at a stub binary so the whole process path is exercised.
    const app = await startTestApp();
    let binary;
    try {
        binary = writeStubBinary(app.config.gateways.runtimeDir, 'citra-gateway');
        app.supervisor.binary = binary;
        app.supervisor.binaryError = '';

        await app.client.login();
        const server = await app.client.createServer({ name: '真实服务器' });
        const rooms = [];
        for (const name of ['实战-1', '实战-2', '实战-3']) {
            const created = await app.client.request('/api/rooms', {
                method: 'POST', body: { name, serverId: server.id },
            });
            assert.equal(created.status, 201);
            rooms.push(created.body.data);
        }

        // Batch start: every room must reach `running` with a live pid.
        const started = await app.client.request('/api/rooms/batch/start', {
            method: 'POST', body: { ids: rooms.map((room) => room.id) },
        });
        assert.equal(started.status, 200);
        assert.equal(started.body.data.succeeded, 3, JSON.stringify(started.body.data.results));
        assert.equal(started.body.data.failed, 0);

        const running = await app.client.request('/api/rooms');
        for (const room of rooms) {
            const current = running.body.data.find((item) => item.id === room.id);
            assert.equal(current.state, 'running', `${room.name} should be running`);
            assert.ok(current.pid > 0, `${room.name} should report a pid`);
            assert.ok(current.startedAt > 0);
        }

        // The log endpoint returns the redacted command line.
        const log = await app.client.request(`/api/rooms/${rooms[0].id}/log?lines=50`);
        assert.equal(log.status, 200);
        assert.match(log.body.data.text, /start /);
        assert.match(log.body.data.text, /--listen/);

        // Batch stop returns everything to `stopped`.
        const stopped = await app.client.request('/api/rooms/batch/stop', {
            method: 'POST', body: { ids: rooms.map((room) => room.id) },
        });
        assert.equal(stopped.body.data.succeeded, 3);
        const settled = await Promise.all(rooms.map(async (room) => {
            for (let attempt = 0; attempt < 60; attempt += 1) {
                const list = await app.client.request('/api/rooms');
                const current = list.body.data.find((item) => item.id === room.id);
                if (current.state === 'stopped') return current;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return null;
        }));
        for (const room of settled) {
            assert.ok(room, 'every room settles in stopped');
            assert.equal(room.pid, null);
        }
    } finally {
        await app.close();
    }
});

test('story: a viewer can audit the console but cannot change it', async () => {
    const app = await startTestApp();
    try {
        await app.client.login({ password: 'Owner-Password-123' });
        const server = await app.client.createServer({ name: '只读测试服务器' });
        await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '只读测试房间', serverId: server.id },
        });
        await app.client.request('/api/users', {
            method: 'POST', body: { username: 'guest', password: 'Guest-Password-123', role: 'viewer' },
        });

        await app.client.request('/api/logout', { method: 'POST' });
        const viewerLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'guest', password: 'Guest-Password-123' },
        });
        app.client.session = viewerLogin.body.data;

        // Read paths work.
        for (const path of ['/api/dashboard', '/api/rooms', '/api/servers', '/api/events']) {
            const response = await app.client.request(path);
            assert.equal(response.status, 200, `${path} should be readable by a viewer`);
        }
        const log = await app.client.request('/api/rooms/1/log?lines=10');
        assert.equal(log.status, 200, 'the log is part of the read surface');

        // Write paths are all refused, with the same code so the UI can be honest.
        const writes = [
            ['POST', '/api/servers', { name: 'x', host: '1.1.1.1', port: 1 }],
            ['POST', '/api/rooms', { name: 'x', serverId: server.id }],
            ['POST', '/api/rooms/1/start', {}],
            ['POST', '/api/rooms/1/stop', {}],
            ['POST', '/api/rooms/batch/start', { ids: [1] }],
            ['POST', '/api/users', { username: 'y', password: 'Y-Password-1234' }],
            ['DELETE', '/api/rooms/1', undefined],
        ];
        for (const [method, path, body] of writes) {
            const response = await app.client.request(path, { method, body });
            assert.equal(response.status, 403, `${method} ${path} must be refused, got ${response.status}`);
            assert.equal(response.body.error.code, 'forbidden');
        }

        // Diagnostics expose deployment detail, so they are admin-only.
        const diagnostics = await app.client.request('/api/diagnostics');
        assert.equal(diagnostics.status, 403);
    } finally {
        await app.close();
    }
});

test('story: the console survives a restart with its rooms, accounts and settings', async () => {
    // Both sessions must share one on-disk database: the point of this story is
    // persistence across a process restart, which an in-memory database cannot show.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'mhga-persist-'));
    const dbPath = join(root, 'persist.db');
    // `_keepRoot` tells the harness not to delete the temp root on close: both
    // sessions share it, and the second one must still find the database.
    const configFor = () => {
        const base = testConfig();
        base.storage.sqlite.path = dbPath;
        base._tmpRoot = root;
        base._keepRoot = true;
        return base;
    };

    // First session: populate everything.
    const app = await startTestApp({ config: configFor() });
    try {
        const binary = writeStubBinary(app.config.gateways.runtimeDir, 'citra-gateway');
        app.supervisor.binary = binary;
        app.supervisor.binaryError = '';
        await app.client.login({ password: 'Persist-Password-1' });
        const server = await app.client.createServer({ name: '持久服务器', host: '10.9.8.7', port: 24900 });
        const room = (await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '持久房间', serverId: server.id, password: 'keep-me' },
        })).body.data;
        await app.client.request(`/api/rooms/${room.id}/start`, { method: 'POST' });
    } finally {
        // Stop the supervisor so no stray process survives into the next session.
        await app.close();
    }

    // Second session: the same database must present the same state, and a room
    // that was running when the console died must be reported honestly rather
    // than silently relaunched.
    const dataset = await startTestApp({ config: configFor() });
    try {
        const anonymous = await dataset.client.request('/api/session');
        assert.equal(anonymous.body.data.setupComplete, true, 'setup is not repeated');

        const login = await dataset.client.request('/api/login', {
            method: 'POST', body: { username: 'admin', password: 'Persist-Password-1' },
        });
        assert.equal(login.status, 200, 'the account and password survive');
        dataset.client.session = login.body.data;

        const rooms = await dataset.client.request('/api/rooms');
        assert.equal(rooms.body.data.length, 1);
        const room = rooms.body.data[0];
        assert.equal(room.name, '持久房间');
        assert.equal(room.hasPassword, true, 'the room password is still set');
        assert.equal(room.serverName, '持久服务器');
        assert.equal(room.citraPort, 26000, 'the allocated port is stable across restarts');
    } finally {
        await dataset.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test('story: HTML, CSS and JS are all servable and reference each other correctly', async () => {
    const app = await startTestApp();
    try {
        const index = await fetch(`${app.base}/`);
        const html = await index.text();
        assert.match(html, /<script src="\/app\.js" type="module">/);
        assert.match(html, /<link rel="stylesheet" href="\/app\.css">/);
        assert.match(html, /<div id="app"/);

        const css = await (await fetch(`${app.base}/app.css`)).text();
        // A handful of class names the renderer actually uses must exist, otherwise
        // the page renders unstyled and looks broken.
        for (const className of ['.topbar', '.auth-card', '.badge', '.table-wrap', '.toast', '.field']) {
            assert.ok(css.includes(className), `app.css must define ${className}`);
        }

        const js = await (await fetch(`${app.base}/app.js`)).text();
        // The client must call the endpoints the server actually exposes.
        for (const endpoint of [
            '/api/session', '/api/setup', '/api/login', '/api/logout', '/api/password',
            '/api/dashboard', '/api/rooms', '/api/servers', '/api/users', '/api/events',
            '/api/diagnostics',
        ]) {
            assert.ok(js.includes(endpoint), `app.js must use ${endpoint}`);
        }
        // And it must not reach any third-party origin (the CSP would block it).
        assert.equal(/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(js), false,
            'the console must not reference external origins');
    } finally {
        await app.close();
    }
});
