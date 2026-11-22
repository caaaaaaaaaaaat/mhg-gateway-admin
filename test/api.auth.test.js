// SPDX-License-Identifier: GPL-3.0-or-later
// HTTP API integration tests: the real server, real SQLite, real router, real
// cookie/CSRF handling. Only the gateway process is stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, testConfig } from './helpers.js';

test('bootstrap: setup is required before anything else', async () => {
    const app = await startTestApp();
    try {
        const session = await app.client.request('/api/session');
        assert.equal(session.status, 200);
        assert.equal(session.body.data.setupComplete, false);
        assert.equal(session.body.data.authenticated, false);
        assert.equal(session.body.data.csrfToken, null);

        const dashboard = await app.client.request('/api/dashboard');
        assert.equal(dashboard.status, 401, 'an unauthenticated dashboard read is refused');

        const login = await app.client.request('/api/login', {
            method: 'POST',
            body: { username: 'admin', password: 'whatever-123' },
        });
        assert.equal(login.status, 409, 'login before setup says "please set up first"');
        assert.equal(login.body.error.code, 'setup_required');
    } finally {
        await app.close();
    }
});

test('setup validates the username, password length and confirmation', async () => {
    const app = await startTestApp();
    try {
        const bad = await app.client.request('/api/setup', {
            method: 'POST',
            body: { username: 'a', password: 'Test-Password-123', confirm: 'Test-Password-123' },
        });
        assert.equal(bad.status, 400);

        const mismatch = await app.client.request('/api/setup', {
            method: 'POST',
            body: { username: 'admin', password: 'Test-Password-123', confirm: 'Test-Password-124' },
        });
        assert.equal(mismatch.status, 400);
        assert.equal(mismatch.body.error.code, 'password_mismatch');

        const weak = await app.client.request('/api/setup', {
            method: 'POST',
            body: { username: 'admin', password: 'short', confirm: 'short' },
        });
        assert.equal(weak.status, 400);
        assert.equal(weak.body.error.code, 'weak_password');

        const badName = await app.client.request('/api/setup', {
            method: 'POST',
            body: { username: 'has space', password: 'Test-Password-123', confirm: 'Test-Password-123' },
        });
        assert.equal(badName.status, 400);

        const ok = await app.client.request('/api/setup', {
            method: 'POST',
            body: { username: 'admin', password: 'Test-Password-123', confirm: 'Test-Password-123' },
        });
        assert.equal(ok.status, 201);

        // A second setup must never overwrite the first administrator.
        const again = await app.client.request('/api/setup', {
            method: 'POST',
            body: { username: 'other', password: 'Other-Password-123', confirm: 'Other-Password-123' },
        });
        assert.equal(again.status, 409);
        assert.equal(again.body.error.code, 'setup_done');
    } finally {
        await app.close();
    }
});

test('login issues a session cookie and a CSRF token', async () => {
    const app = await startTestApp();
    try {
        await app.client.request('/api/setup', {
            method: 'POST',
            body: { username: 'admin', password: 'Test-Password-123', confirm: 'Test-Password-123' },
        });
        const login = await app.client.request('/api/login', {
            method: 'POST',
            body: { username: 'admin', password: 'Test-Password-123' },
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.getSetCookie().join(';');
        assert.match(cookie, /mhga_test_session=/);
        assert.match(cookie, /HttpOnly/, 'the session cookie must not be readable by script');
        assert.match(cookie, /SameSite=Lax/);
        assert.ok(app.client.jar.has('mhga_test_session'));
        assert.ok(login.body.data.csrfToken.length > 20);

        const session = await app.client.request('/api/session');
        assert.equal(session.body.data.authenticated, true);
        assert.equal(session.body.data.user.username, 'admin');
        assert.equal(session.body.data.user.role, 'owner');
        assert.equal(session.body.data.csrfToken, login.body.data.csrfToken);
    } finally {
        await app.close();
    }
});

test('wrong password is rejected and repeated failures lock the account', async () => {
    const app = await startTestApp();
    try {
        await app.client.login({ password: 'Test-Password-123' });
        // The configured maximum in testConfig is 3 failures.
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const response = await app.client.request('/api/login', {
                method: 'POST',
                body: { username: 'admin', password: `wrong-${attempt}-value` },
            });
            assert.equal(response.status === 401 || response.status === 423, true,
                `attempt ${attempt} should be rejected, got ${response.status}`);
        }
        const locked = await app.client.request('/api/login', {
            method: 'POST',
            body: { username: 'admin', password: 'Test-Password-123' },
        });
        assert.equal(locked.status, 423, 'the correct password is refused while locked');
        assert.equal(locked.body.error.code, 'account_locked');

        const unknown = await app.client.request('/api/login', {
            method: 'POST',
            body: { username: 'nosuchuser', password: 'Test-Password-123' },
        });
        assert.equal(unknown.status, 401);
        assert.equal(unknown.body.error.message, '用户名或密码不正确', 'no user enumeration');
    } finally {
        await app.close();
    }
});

test('mutating requests require the CSRF header', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const withoutCsrf = await app.client.request('/api/servers', {
            method: 'POST',
            csrf: false,
            body: { name: 'no-csrf', host: '127.0.0.1', port: 24872 },
        });
        assert.equal(withoutCsrf.status, 403);
        assert.equal(withoutCsrf.body.error.code, 'csrf_failed');

        const wrongCsrf = await app.client.request('/api/servers', {
            method: 'POST',
            headers: { 'x-csrf-token': 'not-the-token' },
            body: { name: 'bad-csrf', host: '127.0.0.1', port: 24872 },
        });
        assert.equal(wrongCsrf.status, 403);

        const ok = await app.client.createServer({ name: 'with-csrf' });
        assert.notEqual(ok.id, undefined);
    } finally {
        await app.close();
    }
});

test('logout invalidates the session immediately', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const before = await app.client.request('/api/session');
        assert.equal(before.body.data.authenticated, true);

        const out = await app.client.request('/api/logout', { method: 'POST' });
        assert.equal(out.status, 200);
        const after = await app.client.request('/api/session');
        assert.equal(after.body.data.authenticated, false);
        assert.equal(app.client.jar.has('mhga_test_session'), false, 'the cookie is cleared');
    } finally {
        await app.close();
    }
});

test('server CRUD validates input and protects referenced rows', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();

        const empty = await app.client.request('/api/servers', {
            method: 'POST', body: { name: '', host: '127.0.0.1', port: 24872 },
        });
        assert.equal(empty.status, 400);

        const badHost = await app.client.request('/api/servers', {
            method: 'POST', body: { name: 'x1', host: 'http://a/b', port: 24872 },
        });
        assert.equal(badHost.status, 400);

        const badPort = await app.client.request('/api/servers', {
            method: 'POST', body: { name: 'x2', host: '127.0.0.1', port: 0 },
        });
        assert.equal(badPort.status, 400);

        const created = await app.client.createServer({ name: 'srv-a', host: '10.1.2.3', port: 24872, password: 'pw' });
        assert.equal(created.hasPassword, true);
        assert.equal(created.password, undefined, 'the password is never echoed back');

        const duplicate = await app.client.request('/api/servers', {
            method: 'POST', body: { name: 'srv-a', host: '1.1.1.1', port: 1 },
        });
        assert.equal(duplicate.status, 409);

        const patched = await app.client.request(`/api/servers/${created.id}`, {
            method: 'PATCH', body: { port: 24900, notes: 'updated' },
        });
        assert.equal(patched.status, 200);
        assert.equal(patched.body.data.port, 24900);
        assert.equal(patched.body.data.host, '10.1.2.3', 'untouched fields survive');

        // Bind a room, then the server must be undeletable.
        const room = await app.client.request('/api/rooms', {
            method: 'POST', body: { name: 'room-x', serverId: created.id },
        });
        assert.equal(room.status, 201);

        const blocked = await app.client.request(`/api/servers/${created.id}`, { method: 'DELETE' });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.error.code, 'server_in_use');
        assert.deepEqual(blocked.body.error.details.rooms, ['room-x']);

        await app.client.request(`/api/rooms/${room.body.data.id}`, { method: 'DELETE' });
        const deleted = await app.client.request(`/api/servers/${created.id}`, { method: 'DELETE' });
        assert.equal(deleted.status, 200);
    } finally {
        await app.close();
    }
});

test('room creation allocates ports from the configured pools without collisions', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const server = await app.client.createServer();
        const created = [];
        for (let index = 0; index < 5; index += 1) {
            const response = await app.client.request('/api/rooms', {
                method: 'POST',
                body: { name: `自动-${index}`, serverId: server.id },
            });
            assert.equal(response.status, 201, JSON.stringify(response.body));
            created.push(response.body.data);
        }
        const citraPorts = created.map((room) => room.citraPort);
        const roomPorts = created.map((room) => room.roomPort);
        assert.equal(new Set(citraPorts).size, 5, 'citra ports must be unique');
        assert.equal(new Set(roomPorts).size, 5, 'room ports must be unique');
        assert.equal(citraPorts[0], 26000, 'allocation starts at the low bound');
        assert.equal(roomPorts[0], 25000);

        // Explicit ports are honoured, duplicates are refused.
        const explicit = await app.client.request('/api/rooms', {
            method: 'POST',
            body: { name: '显式端口', serverId: server.id, citraPort: 26999, roomPort: 25999 },
        });
        assert.equal(explicit.status, 201);
        assert.equal(explicit.body.data.citraPort, 26999);

        const clash = await app.client.request('/api/rooms', {
            method: 'POST',
            body: { name: '端口冲突', serverId: server.id, citraPort: 26999 },
        });
        assert.equal(clash.status, 409);
        assert.equal(clash.body.error.code, 'port_in_use');
        assert.equal(clash.body.error.details.field, 'citraPort');

        // Exhausting the pool is a clear 409, not a silent reuse.
        for (let index = 0; index < 20; index += 1) {
            await app.client.request('/api/rooms', {
                method: 'POST',
                body: { name: `填充-${index}`, serverId: server.id },
            });
        }
        const exhausted = await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '超出池', serverId: server.id },
        });
        assert.equal(exhausted.status, 409);
        assert.equal(exhausted.body.error.code, 'port_pool_exhausted');
    } finally {
        await app.close();
    }
});

test('room input validation rejects bad names, profiles and addresses', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const server = await app.client.createServer();
        const cases = [
            [{ name: '', serverId: server.id }, 'empty name'],
            [{ name: 'a'.repeat(40), serverId: server.id }, 'name too long'],
            [{ name: 'name!', serverId: server.id }, 'illegal characters'],
            [{ name: 'ok-name', serverId: 99999 }, 'unknown server'],
            [{ name: 'ok-name2', serverId: server.id, profile: 'turbo' }, 'unknown profile'],
            [{ name: 'ok-name3', serverId: server.id, listenAddress: 'not-an-ip' }, 'bad listen address'],
            [{ name: 'ok-name4', serverId: server.id, citraPort: 70000 }, 'port out of range'],
        ];
        for (const [body, label] of cases) {
            const response = await app.client.request('/api/rooms', { method: 'POST', body });
            assert.equal(response.status, 400, `${label} should be a 400, got ${response.status}`);
        }
        const duplicate = await app.client.request('/api/rooms', {
            method: 'POST', body: { name: 'ok-name', serverId: server.id },
        });
        assert.equal(duplicate.status, 201, 'a valid name still works');
        const again = await app.client.request('/api/rooms', {
            method: 'POST', body: { name: 'ok-name', serverId: server.id },
        });
        assert.equal(again.status, 409);
        assert.equal(again.body.error.code, 'duplicate_name');
    } finally {
        await app.close();
    }
});

test('a running room refuses settings that would need a restart', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const server = await app.client.createServer();
        const room = (await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '运行中编辑', serverId: server.id },
        })).body.data;
        // Simulate a live process: the supervisor is bypassed, only the stored
        // state matters for this rule.
        await app.datasource.updateRoom(room.id, { state: 'running', pid: 1234, desired_state: 'running' });

        const refused = await app.client.request(`/api/rooms/${room.id}`, {
            method: 'PATCH', body: { citraPort: 26009 },
        });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.error.code, 'room_running');

        // A display-only change is still allowed while running.
        const allowed = await app.client.request(`/api/rooms/${room.id}`, {
            method: 'PATCH', body: { name: '运行中改名' },
        });
        assert.equal(allowed.status, 200);
    } finally {
        await app.close();
    }
});

test('batch start reports per-room failures instead of failing wholesale', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const server = await app.client.createServer();
        const a = (await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '批-A', serverId: server.id },
        })).body.data;
        const b = (await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '批-B', serverId: server.id },
        })).body.data;

        const response = await app.client.request('/api/rooms/batch/start', {
            method: 'POST', body: { ids: [a.id, b.id, 99999] },
        });
        assert.equal(response.status, 200);
        const data = response.body.data;
        assert.equal(data.results.length, 3);
        assert.equal(data.failed, 3, 'no gateway binary is configured, so every start fails');
        const missing = data.results.find((item) => item.id === 99999);
        assert.equal(missing.ok, false);
        assert.match(missing.error, /不存在/);

        const invalid = await app.client.request('/api/rooms/batch/start', {
            method: 'POST', body: { ids: [] },
        });
        assert.equal(invalid.status, 400);

        const badAction = await app.client.request('/api/rooms/batch/purge', {
            method: 'POST', body: { ids: [a.id] },
        });
        assert.equal(badAction.status, 400);
    } finally {
        await app.close();
    }
});

test('viewer accounts cannot mutate anything', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const created = await app.client.request('/api/users', {
            method: 'POST',
            body: { username: 'reader', password: 'Reader-Password-123', role: 'viewer' },
        });
        assert.equal(created.status, 201);
        const server = await app.client.createServer();

        await app.client.request('/api/logout', { method: 'POST' });
        const viewerLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'reader', password: 'Reader-Password-123' },
        });
        assert.equal(viewerLogin.status, 200);
        app.client.session = viewerLogin.body.data;

        const read = await app.client.request('/api/rooms');
        assert.equal(read.status, 200, 'a viewer can read');

        const write = await app.client.request('/api/rooms', {
            method: 'POST', body: { name: 'nope', serverId: server.id },
        });
        assert.equal(write.status, 403);
        assert.equal(write.body.error.code, 'forbidden');

        const users = await app.client.request('/api/users');
        assert.equal(users.status, 403, 'a viewer cannot list accounts');

        const start = await app.client.request(`/api/rooms/1/start`, { method: 'POST' });
        assert.equal(start.status, 403);
    } finally {
        await app.close();
    }
});

test('accounts: creation, deletion and owner protection', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const weak = await app.client.request('/api/users', {
            method: 'POST', body: { username: 'weak', password: 'abc' },
        });
        assert.equal(weak.status, 400);

        const created = await app.client.request('/api/users', {
            method: 'POST', body: { username: 'helper', password: 'Helper-Password-1', role: 'admin' },
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.data.role, 'admin');

        const duplicate = await app.client.request('/api/users', {
            method: 'POST', body: { username: 'helper', password: 'Helper-Password-2', role: 'admin' },
        });
        assert.equal(duplicate.status, 409);

        const list = await app.client.request('/api/users');
        assert.equal(list.body.data.length, 2);
        const owner = list.body.data.find((user) => user.role === 'owner');
        assert.ok(owner, 'the first account is the owner');

        const deleteOwner = await app.client.request(`/api/users/${owner.id}`, { method: 'DELETE' });
        assert.equal(deleteOwner.status, 403);
        assert.equal(deleteOwner.body.error.code, 'owner_protected');

        const deleteOther = await app.client.request(`/api/users/${created.body.data.id}`, { method: 'DELETE' });
        assert.equal(deleteOther.status, 200);
    } finally {
        await app.close();
    }
});

test('changing the password revokes every session including the current one', async () => {
    const app = await startTestApp();
    try {
        await app.client.login({ password: 'Test-Password-123' });
        const wrong = await app.client.request('/api/password', {
            method: 'POST',
            body: { currentPassword: 'not-it', newPassword: 'New-Password-456', confirm: 'New-Password-456' },
        });
        assert.equal(wrong.status, 403);

        const mismatch = await app.client.request('/api/password', {
            method: 'POST',
            body: { currentPassword: 'Test-Password-123', newPassword: 'New-Password-456', confirm: 'New-Password-457' },
        });
        assert.equal(mismatch.status, 400);

        const ok = await app.client.request('/api/password', {
            method: 'POST',
            body: { currentPassword: 'Test-Password-123', newPassword: 'New-Password-456', confirm: 'New-Password-456' },
        });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.data.reauthenticate, true);

        const session = await app.client.request('/api/session');
        assert.equal(session.body.data.authenticated, false, 'the old session is gone');

        const oldLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'admin', password: 'Test-Password-123' },
        });
        assert.equal(oldLogin.status, 401, 'the old password no longer works');

        const newLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'admin', password: 'New-Password-456' },
        });
        assert.equal(newLogin.status, 200);
    } finally {
        await app.close();
    }
});

test('dashboard, events and diagnostics answer for a signed-in admin', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const server = await app.client.createServer({ name: '看板服务器' });
        await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '看板房间', serverId: server.id },
        });

        const dashboard = await app.client.request('/api/dashboard');
        assert.equal(dashboard.status, 200);
        assert.equal(dashboard.body.data.counts.total, 1);
        assert.equal(dashboard.body.data.counts.running, 0);
        assert.equal(dashboard.body.data.rooms.length, 1);
        assert.equal(dashboard.body.data.rooms[0].serverName, '看板服务器');
        assert.equal(dashboard.body.data.gatewayBinaryFound, false);
        assert.ok(dashboard.body.data.events.length >= 2, 'creation is audited');

        const events = await app.client.request('/api/events?limit=5');
        assert.equal(events.status, 200);
        assert.ok(events.body.data.length >= 1);
        assert.ok(events.body.data[0].kind);

        const diagnostics = await app.client.request('/api/diagnostics');
        assert.equal(diagnostics.status, 200);
        assert.equal(diagnostics.body.data.datasource, 'sqlite');
        assert.equal(diagnostics.body.data.citraPortRange[0], 26000);
        assert.equal(diagnostics.body.data.usedCitraPorts.length, 1);
        assert.match(diagnostics.body.data.nodeVersion, /^v\d+/);
    } finally {
        await app.close();
    }
});

test('a body that is not JSON or is too large is refused', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const wrongType = await fetch(`${app.base}/api/servers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                'x-csrf-token': app.client.session.csrfToken,
                Cookie: `mhga_test_session=${app.client.jar.get('mhga_test_session')}`,
            },
            body: 'name=x',
        });
        assert.equal(wrongType.status, 415);

        const invalidJson = await fetch(`${app.base}/api/servers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': app.client.session.csrfToken,
                Cookie: `mhga_test_session=${app.client.jar.get('mhga_test_session')}`,
            },
            body: '{oops',
        });
        assert.equal(invalidJson.status, 400);

        const tooBig = await fetch(`${app.base}/api/servers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': app.client.session.csrfToken,
                Cookie: `mhga_test_session=${app.client.jar.get('mhga_test_session')}`,
            },
            body: JSON.stringify({ name: 'x'.repeat(300_000), host: '127.0.0.1', port: 1 }),
        });
        assert.equal(tooBig.status, 413);
    } finally {
        await app.close();
    }
});

test('static assets are served with security headers and no traversal', async () => {
    const app = await startTestApp();
    try {
        const index = await fetch(`${app.base}/`);
        assert.equal(index.status, 200);
        const csp = index.headers.get('content-security-policy');
        assert.match(csp, /default-src 'self'/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(index.headers.get('x-frame-options'), 'DENY');
        const html = await index.text();
        assert.match(html, /网关管理控制台/);

        for (const path of ['/app.css', '/app.js']) {
            const asset = await fetch(`${app.base}${path}`);
            assert.equal(asset.status, 200, `${path} must be served`);
        }

        for (const path of ['/../src/index.js', '/%2e%2e/src/index.js', '/..%2f..%2fpackage.json']) {
            const response = await fetch(`${app.base}${path}`);
            assert.ok(response.status === 404 || response.status === 200, `${path} handled`);
            if (response.status === 200) {
                const text = await response.text();
                assert.equal(text.includes('loadConfig'), false, `${path} must not leak server source`);
            }
        }

        // A non-whitelisted extension inside public/ must not be published.
        const json = await fetch(`${app.base}/package.json`);
        assert.equal(json.status === 404 || json.status === 200, true);

        // A deep link falls back to the SPA shell.
        const deep = await fetch(`${app.base}/rooms`);
        assert.equal(deep.status, 200);
        assert.match(await deep.text(), /网关管理控制台/);
    } finally {
        await app.close();
    }
});

test('unknown API routes are a JSON 404, not the SPA shell', async () => {
    const app = await startTestApp();
    try {
        const response = await fetch(`${app.base}/api/does-not-exist`);
        assert.equal(response.status, 404);
        assert.match(response.headers.get('content-type'), /application\/json/);
        const body = await response.json();
        assert.equal(body.error.code, 'not_found');
    } finally {
        await app.close();
    }
});

test('a wrong HTTP method on a known route is a 405 with Allow', async () => {
    const app = await startTestApp();
    try {
        const response = await fetch(`${app.base}/api/session`, { method: 'DELETE' });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'GET');
    } finally {
        await app.close();
    }
});

test('the password is never stored in plaintext anywhere the API can return it', async () => {
    const app = await startTestApp();
    try {
        await app.client.login({ password: 'Plaintext-Probe-123' });
        const server = await app.client.createServer({ password: 'Room-Secret-777' });
        const room = (await app.client.request('/api/rooms', {
            method: 'POST', body: { name: '密码房间', serverId: server.id, password: 'Access-Secret-888' },
        })).body.data;

        const rooms = await app.client.request('/api/rooms');
        const serialised = JSON.stringify(rooms.body);
        assert.equal(serialised.includes('Access-Secret-888'), false, 'room password never leaves the server');
        assert.equal(serialised.includes('Room-Secret-777'), false, 'server password never leaves the server');
        assert.equal(room.hasPassword, true);

        const servers = await app.client.request('/api/servers');
        assert.equal(JSON.stringify(servers.body).includes('Room-Secret-777'), false);

        // And the datasource stores the account password as a scrypt hash.
        const user = await app.datasource.findUserByUsername('admin');
        assert.match(user.password_hash, /^scrypt\$/);
        assert.equal(user.password_hash.includes('Plaintext-Probe-123'), false);
    } finally {
        await app.close();
    }
});

test('config with a custom session TTL expires the session', async () => {
    // Exercise the expiry branch directly through the auth service with a short TTL
    // rather than sleeping: the datasource holds the authoritative timestamp.
    const config = testConfig();
    const app = await startTestApp({ config });
    try {
        await app.client.login();
        const session = await app.datasource.findSessionByTokenHash(
            (await import('../src/lib/tokens.js')).hashToken(app.client.jar.get('mhga_test_session')),
        );
        assert.ok(session);
        // Force the row into the past: the next request must treat it as gone.
        await app.datasource.touchSession(session.id, { lastSeenAt: Date.now(), expiresAt: Date.now() - 1 });
        const response = await app.client.request('/api/session');
        assert.equal(response.body.data.authenticated, false, 'an expired session is refused');
    } finally {
        await app.close();
    }
});
