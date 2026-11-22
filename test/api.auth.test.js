// SPDX-License-Identifier: GPL-3.0-or-later
// HTTP API integration tests: the real server, real SQLite, real router, real
// cookie/CSRF handling. Only the gateway process is stubbed.
//
// The subject is the MAPPING: one local port -> one upstream room server.

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
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Lax/);
        assert.ok(login.body.data.csrfToken.length > 20);

        const session = await app.client.request('/api/session');
        assert.equal(session.body.data.authenticated, true);
        assert.equal(session.body.data.user.role, 'owner');
    } finally {
        await app.close();
    }
});

test('wrong password is rejected and repeated failures lock the account', async () => {
    const app = await startTestApp();
    try {
        await app.client.login({ password: 'Test-Password-123' });
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const response = await app.client.request('/api/login', {
                method: 'POST',
                body: { username: 'admin', password: `wrong-${attempt}-value` },
            });
            assert.equal(response.status === 401 || response.status === 423, true);
        }
        const locked = await app.client.request('/api/login', {
            method: 'POST',
            body: { username: 'admin', password: 'Test-Password-123' },
        });
        assert.equal(locked.status, 423);
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
        const withoutCsrf = await app.client.request('/api/mappings', {
            method: 'POST',
            csrf: false,
            body: { targetHost: '127.0.0.1', targetPort: 24872 },
        });
        assert.equal(withoutCsrf.status, 403);
        assert.equal(withoutCsrf.body.error.code, 'csrf_failed');

        const wrongCsrf = await app.client.request('/api/mappings', {
            method: 'POST',
            headers: { 'x-csrf-token': 'not-the-token' },
            body: { targetHost: '127.0.0.1', targetPort: 24872 },
        });
        assert.equal(wrongCsrf.status, 403);

        const ok = await app.client.createMapping();
        assert.notEqual(ok.id, undefined);
    } finally {
        await app.close();
    }
});

test('logout invalidates the session immediately', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const out = await app.client.request('/api/logout', { method: 'POST' });
        assert.equal(out.status, 200);
        const after = await app.client.request('/api/session');
        assert.equal(after.body.data.authenticated, false);
    } finally {
        await app.close();
    }
});

test('a mapping stores one pair: local port and upstream server', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const created = await app.client.request('/api/mappings', {
            method: 'POST',
            body: {
                name: 'oku-1',
                localPort: 26005,
                targetHost: 'www.okuapi.xyz',
                targetPort: 9901,
                password: 'pw',
            },
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const mapping = created.body.data;

        // The pair, stored as typed.
        assert.equal(mapping.localPort, 26005);
        assert.equal(mapping.targetHost, 'www.okuapi.xyz');
        assert.equal(mapping.targetPort, 9901);
        // The upstream password is stored but never echoed.
        assert.equal(mapping.hasPassword, true);
        assert.equal(mapping.password, undefined);
        assert.equal(mapping.state, 'stopped');
        // There is no separate server entity any more.
        assert.equal('serverId' in mapping, false);
        assert.equal('citraPort' in mapping, false);
        assert.equal('roomPort' in mapping, false);
    } finally {
        await app.close();
    }
});

test('a blank local port is allocated from the pool', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const created = [];
        for (let index = 0; index < 5; index += 1) {
            const response = await app.client.request('/api/mappings', {
                method: 'POST',
                body: { targetHost: '10.0.0.1', targetPort: 24872 },
            });
            assert.equal(response.status, 201, JSON.stringify(response.body));
            created.push(response.body.data);
        }
        const ports = created.map((row) => row.localPort);
        assert.equal(new Set(ports).size, 5, 'each blank port gets a distinct one');
        // testConfig's pool is 26000..26010, so allocation starts at the low bound.
        assert.equal(ports[0], 26000);
        assert.equal(ports[4], 26004);
        // A blank name is derived from the port, which is what an operator would
        // have typed anyway.
        assert.equal(created[0].name, '端口26000');
    } finally {
        await app.close();
    }
});

test('an explicit local port is honoured and conflicts are refused', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const first = await app.client.request('/api/mappings', {
            method: 'POST',
            body: { localPort: 26010, targetHost: '10.0.0.1', targetPort: 24872 },
        });
        assert.equal(first.status, 201);
        assert.equal(first.body.data.localPort, 26010);

        const clash = await app.client.request('/api/mappings', {
            method: 'POST',
            body: { localPort: 26010, targetHost: '10.0.0.2', targetPort: 24873 },
        });
        assert.equal(clash.status, 409);
        assert.equal(clash.body.error.code, 'port_in_use');
        assert.equal(clash.body.error.details.port, 26010);

        // Exhausting the pool is a clear 409, never a silent reuse.
        // testConfig's pool is 26000..26010 (11 ports); 26010 is taken above, so ten
        // more blank allocations fill it.
        for (let index = 0; index < 10; index += 1) {
            await app.client.request('/api/mappings', {
                method: 'POST',
                body: { targetHost: '10.0.0.1', targetPort: 24872 },
            });
        }
        const exhausted = await app.client.request('/api/mappings', {
            method: 'POST',
            body: { targetHost: '10.0.0.1', targetPort: 24872 },
        });
        assert.equal(exhausted.status, 409);
        assert.equal(exhausted.body.error.code, 'port_pool_exhausted');
    } finally {
        await app.close();
    }
});

test('mapping input validation rejects a bad pair', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const cases = [
            [{ targetPort: 24872 }, 'missing target host'],
            [{ targetHost: '10.0.0.1' }, 'missing target port'],
            [{ targetHost: '10.0.0.1', targetPort: 0 }, 'target port out of range'],
            [{ targetHost: '10.0.0.1', targetPort: 70000 }, 'target port too large'],
            [{ targetHost: 'http://a/b', targetPort: 24872 }, 'host with a scheme'],
            [{ targetHost: 'www.example.com:9901', targetPort: 9901 }, 'host with an embedded port'],
            [{ targetHost: '10.0.0.1', targetPort: 24872, localPort: 70000 }, 'local port out of range'],
            [{ targetHost: '10.0.0.1', targetPort: 24872, profile: 'turbo' }, 'unknown profile'],
            [{ targetHost: '10.0.0.1', targetPort: 24872, listenAddress: 'nope' }, 'bad listen address'],
        ];
        for (const [body, label] of cases) {
            const response = await app.client.request('/api/mappings', { method: 'POST', body });
            assert.equal(response.status, 400, `${label} should be a 400, got ${response.status}`);
        }

        const duplicate = await app.client.request('/api/mappings', {
            method: 'POST', body: { name: 'dup-name', targetHost: '10.0.0.1', targetPort: 24872 },
        });
        assert.equal(duplicate.status, 201);
        const again = await app.client.request('/api/mappings', {
            method: 'POST', body: { name: 'dup-name', targetHost: '10.0.0.1', targetPort: 24872 },
        });
        assert.equal(again.status, 409);
        assert.equal(again.body.error.code, 'duplicate_name');
    } finally {
        await app.close();
    }
});

test('a running mapping refuses changes that need a restart', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const mapping = await app.client.createMapping({ name: '运行中' });
        // Simulate a live process: the supervisor is bypassed; only the stored state
        // matters for this rule.
        await app.datasource.updateMapping(mapping.id, {
            state: 'running', pid: 1234, desired_state: 'running',
        });

        const refused = await app.client.request(`/api/mappings/${mapping.id}`, {
            method: 'PATCH', body: { targetPort: 9901 },
        });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.error.code, 'mapping_running');

        const refusedPort = await app.client.request(`/api/mappings/${mapping.id}`, {
            method: 'PATCH', body: { localPort: 26009 },
        });
        assert.equal(refusedPort.status, 409, 'the local port also needs a restart');

        // A display-only change is still allowed while running.
        const allowed = await app.client.request(`/api/mappings/${mapping.id}`, {
            method: 'PATCH', body: { name: '运行中改名' },
        });
        assert.equal(allowed.status, 200);

        // And a running mapping cannot be deleted (that would orphan the process).
        const del = await app.client.request(`/api/mappings/${mapping.id}`, { method: 'DELETE' });
        assert.equal(del.status, 409);
    } finally {
        await app.close();
    }
});

test('editing an idle mapping changes the target and keeps the rest', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const mapping = await app.client.createMapping({
            name: 'idle', localPort: 26003, targetHost: '10.0.0.1', targetPort: 24872, password: 'secret',
        });
        const patched = await app.client.request(`/api/mappings/${mapping.id}`, {
            method: 'PATCH',
            body: { targetHost: '10.0.0.9', targetPort: 9901, notes: 'updated' },
        });
        assert.equal(patched.status, 200);
        assert.equal(patched.body.data.targetHost, '10.0.0.9');
        assert.equal(patched.body.data.targetPort, 9901);
        assert.equal(patched.body.data.localPort, 26003, 'untouched fields survive');
        assert.equal(patched.body.data.hasPassword, true, 'an untouched password stays set');
        assert.equal(patched.body.data.notes, 'updated');
    } finally {
        await app.close();
    }
});

test('batch start reports per-mapping failures instead of failing wholesale', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const a = await app.client.createMapping({ name: '批-A' });
        const b = await app.client.createMapping({ name: '批-B' });

        const response = await app.client.request('/api/mappings/batch/start', {
            method: 'POST', body: { ids: [a.id, b.id, 99999] },
        });
        assert.equal(response.status, 200);
        const data = response.body.data;
        assert.equal(data.results.length, 3);
        assert.equal(data.failed, 3, 'no gateway binary is configured, so every start fails');
        const missing = data.results.find((item) => item.id === 99999);
        assert.equal(missing.ok, false);
        assert.match(missing.error, /不存在/);

        const invalid = await app.client.request('/api/mappings/batch/start', {
            method: 'POST', body: { ids: [] },
        });
        assert.equal(invalid.status, 400);

        const badAction = await app.client.request('/api/mappings/batch/purge', {
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
        const mapping = await app.client.createMapping();

        await app.client.request('/api/logout', { method: 'POST' });
        const viewerLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'reader', password: 'Reader-Password-123' },
        });
        assert.equal(viewerLogin.status, 200);
        app.client.session = viewerLogin.body.data;

        const read = await app.client.request('/api/mappings');
        assert.equal(read.status, 200, 'a viewer can read');

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
            assert.equal(response.body.error.code, 'forbidden');
        }

        const users = await app.client.request('/api/users');
        assert.equal(users.status, 403, 'a viewer cannot list accounts');

        const diagnostics = await app.client.request('/api/diagnostics');
        assert.equal(diagnostics.status, 403);
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
        assert.ok(owner);

        // Owner protection is checked against the acting account: the owner cannot
        // delete itself (self_delete), and another admin cannot delete the owner
        // (owner_protected).
        const selfDelete = await app.client.request(`/api/users/${owner.id}`, { method: 'DELETE' });
        assert.equal(selfDelete.status, 400);
        assert.equal(selfDelete.body.error.code, 'self_delete');

        await app.client.request('/api/logout', { method: 'POST' });
        const adminLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'helper', password: 'Helper-Password-1' },
        });
        app.client.session = adminLogin.body.data;
        const deleteOwner = await app.client.request(`/api/users/${owner.id}`, { method: 'DELETE' });
        assert.equal(deleteOwner.status, 403);
        assert.equal(deleteOwner.body.error.code, 'owner_protected');

        const deleteSelf = await app.client.request(`/api/users/${created.body.data.id}`, { method: 'DELETE' });
        assert.equal(deleteSelf.status, 400);
        assert.equal(deleteSelf.body.error.code, 'self_delete');

        // The owner can remove another account.
        await app.client.request('/api/logout', { method: 'POST' });
        const ownerLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'admin', password: 'Test-Password-123' },
        });
        app.client.session = ownerLogin.body.data;
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

        const ok = await app.client.request('/api/password', {
            method: 'POST',
            body: { currentPassword: 'Test-Password-123', newPassword: 'New-Password-456', confirm: 'New-Password-456' },
        });
        assert.equal(ok.status, 200);

        const session = await app.client.request('/api/session');
        assert.equal(session.body.data.authenticated, false, 'the old session is gone');

        const oldLogin = await app.client.request('/api/login', {
            method: 'POST', body: { username: 'admin', password: 'Test-Password-123' },
        });
        assert.equal(oldLogin.status, 401);

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
        const mapping = await app.client.createMapping({
            name: '看板映射', localPort: 26001, targetHost: '10.1.2.3', targetPort: 9901,
        });

        const dashboard = await app.client.request('/api/dashboard');
        assert.equal(dashboard.status, 200);
        assert.equal(dashboard.body.data.counts.total, 1);
        assert.equal(dashboard.body.data.mappings.length, 1);
        assert.equal(dashboard.body.data.mappings[0].localPort, 26001);
        assert.equal(dashboard.body.data.mappings[0].targetHost, '10.1.2.3');
        assert.equal(dashboard.body.data.gatewayBinaryFound, false);
        assert.ok(dashboard.body.data.events.length >= 1, 'creation is audited');
        assert.deepEqual(dashboard.body.data.localPortRange, [26000, 26010]);

        const events = await app.client.request('/api/events?limit=5');
        assert.equal(events.status, 200);
        assert.ok(events.body.data.some((event) => event.kind === 'mapping.created'));

        const filtered = await app.client.request(`/api/events?mappingId=${mapping.id}`);
        assert.equal(filtered.status, 200);
        assert.ok(filtered.body.data.every((event) => event.mapping_id === mapping.id || event.mapping_id === null));

        const diagnostics = await app.client.request('/api/diagnostics');
        assert.equal(diagnostics.status, 200);
        assert.equal(diagnostics.body.data.datasource, 'sqlite');
        assert.deepEqual(diagnostics.body.data.localPortRange, [26000, 26010]);
        assert.deepEqual(diagnostics.body.data.usedLocalPorts, [26001]);
        assert.match(diagnostics.body.data.nodeVersion, /^v\d+/);
    } finally {
        await app.close();
    }
});

test('a deleted mapping frees its local port', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const mapping = await app.client.createMapping({ localPort: 26000 });
        const del = await app.client.request(`/api/mappings/${mapping.id}`, { method: 'DELETE' });
        assert.equal(del.status, 200);

        // The same port can be claimed again, and a blank allocation reuses the gap.
        const reused = await app.client.request('/api/mappings', {
            method: 'POST', body: { localPort: 26000, targetHost: '10.0.0.1', targetPort: 1 },
        });
        assert.equal(reused.status, 201);

        const auto = await app.client.request('/api/mappings', {
            method: 'POST', body: { targetHost: '10.0.0.1', targetPort: 1 },
        });
        assert.equal(auto.body.data.localPort, 26001, 'the next free port is chosen');
    } finally {
        await app.close();
    }
});

test('a body that is not JSON or is too large is refused', async () => {
    const app = await startTestApp();
    try {
        await app.client.login();
        const cookieHeader = `mhga_test_session=${app.client.jar.get('mhga_test_session')}`;
        const headers = {
            'x-csrf-token': app.client.session.csrfToken,
            Cookie: cookieHeader,
        };
        const wrongType = await fetch(`${app.base}/api/mappings`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: 'name=x',
        });
        assert.equal(wrongType.status, 415);

        const invalidJson = await fetch(`${app.base}/api/mappings`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{oops',
        });
        assert.equal(invalidJson.status, 400);

        const tooBig = await fetch(`${app.base}/api/mappings`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetHost: 'x'.repeat(300_000), targetPort: 1 }),
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
        assert.match(csp, /style-src 'self'/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
        assert.match(await index.text(), /网关管理/);

        for (const path of ['/app.css', '/app.js']) {
            assert.equal((await fetch(`${app.base}${path}`)).status, 200, `${path} must be served`);
        }

        for (const path of ['/../src/index.js', '/%2e%2e/src/index.js']) {
            const response = await fetch(`${app.base}${path}`);
            if (response.status === 200) {
                assert.equal((await response.text()).includes('loadConfig'), false, `${path} must not leak source`);
            }
        }

        const deep = await fetch(`${app.base}/mappings`);
        assert.equal(deep.status, 200);
        assert.match(await deep.text(), /网关管理/);
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
        assert.equal((await response.json()).error.code, 'not_found');

        // The old room/server endpoints are gone, not silently aliased.
        for (const path of ['/api/rooms', '/api/servers']) {
            assert.equal((await fetch(`${app.base}${path}`)).status, 404, `${path} no longer exists`);
        }
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

test('the upstream password is never returned and never stored in plaintext', async () => {
    const app = await startTestApp();
    try {
        await app.client.login({ password: 'Plaintext-Probe-123' });
        const mapping = await app.client.createMapping({ name: '密码映射', password: 'Access-Secret-888' });

        const list = await app.client.request('/api/mappings');
        const serialised = JSON.stringify(list.body);
        assert.equal(serialised.includes('Access-Secret-888'), false, 'the password never leaves the server');
        assert.equal(mapping.hasPassword, true);

        // The account password is a scrypt hash, not the plaintext.
        const user = await app.datasource.findUserByUsername('admin');
        assert.match(user.password_hash, /^scrypt\$/);
        assert.equal(user.password_hash.includes('Plaintext-Probe-123'), false);
    } finally {
        await app.close();
    }
});

test('an expired session is refused', async () => {
    const config = testConfig();
    const app = await startTestApp({ config });
    try {
        await app.client.login();
        const { hashToken } = await import('../src/lib/tokens.js');
        const session = await app.datasource.findSessionByTokenHash(
            hashToken(app.client.jar.get('mhga_test_session')),
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
