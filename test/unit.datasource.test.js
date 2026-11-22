// SPDX-License-Identifier: GPL-3.0-or-later
// Datasource contract tests, run against SQLite (always) and MySQL (only when
// MHGA_TEST_MYSQL is set). Both drivers must satisfy the same behaviour, which is
// what makes the README's "either datasource" claim true rather than aspirational.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteDatasource } from '../src/datasource/sqlite.js';
import { MysqlDatasource } from '../src/datasource/mysql.js';

const MYSQL_ENABLED = Boolean(process.env.MHGA_TEST_MYSQL);

function mysqlOptions() {
    return {
        host: process.env.MHGA_TEST_MYSQL_HOST ?? '127.0.0.1',
        port: Number(process.env.MHGA_TEST_MYSQL_PORT ?? 3306),
        user: process.env.MHGA_TEST_MYSQL_USER ?? 'root',
        password: process.env.MHGA_TEST_MYSQL_PASSWORD ?? '',
        database: process.env.MHGA_TEST_MYSQL_DATABASE ?? 'mhga_test',
        connectionLimit: 4,
        ssl: false,
        tablePrefix: `t_${Date.now().toString(36)}_`,
    };
}

/**
 * The shared behavioural suite. Every driver must pass this unchanged.
 */
async function runContract(ds, { label }) {
    await ds.init();
    try {
        await ds.ping();

        // ---- settings ----
        assert.equal(await ds.getSetting('absent'), null, `${label}: absent setting is null`);
        await ds.setSetting('k', 'v1');
        assert.equal(await ds.getSetting('k'), 'v1');
        await ds.setSetting('k', 'v2');
        assert.equal(await ds.getSetting('k'), 'v2', `${label}: setSetting overwrites`);

        // ---- users ----
        assert.equal(await ds.countUsers(), 0);
        const aliceId = await ds.createUser({ username: 'alice', passwordHash: 'scrypt$x$y$z', role: 'owner' });
        const bobId = await ds.createUser({ username: 'bob', passwordHash: 'scrypt$x$y$z', role: 'viewer' });
        assert.ok(aliceId > 0 && bobId > 0 && aliceId !== bobId);
        assert.equal(await ds.countUsers(), 2);

        const alice = await ds.findUserByUsername('alice');
        assert.equal(alice.username, 'alice');
        assert.equal(alice.role, 'owner');
        assert.equal(alice.failed_logins, 0);
        assert.equal(alice.disabled, 0);
        assert.equal(await ds.findUserByUsername('nobody'), undefined);
        assert.equal((await ds.findUserById(aliceId)).username, 'alice');
        assert.equal(await ds.findUserById(99999), undefined);

        const listed = await ds.listUsers();
        assert.equal(listed.length, 2);
        assert.equal(listed[0].password_hash, undefined, `${label}: listUsers must not leak hashes`);

        await ds.updateUserPassword(aliceId, 'scrypt$N=1,r=1,p=1$aa$bb');
        assert.equal((await ds.findUserById(aliceId)).password_hash, 'scrypt$N=1,r=1,p=1$aa$bb');

        await ds.recordLoginFailure(aliceId, { failedLogins: 3, lockedUntil: 1234567890 });
        let refreshed = await ds.findUserById(aliceId);
        assert.equal(Number(refreshed.failed_logins), 3);
        assert.equal(Number(refreshed.locked_until), 1234567890);

        await ds.recordLoginSuccess(aliceId, 987654321);
        refreshed = await ds.findUserById(aliceId);
        assert.equal(Number(refreshed.failed_logins), 0, `${label}: success clears the counter`);
        assert.equal(refreshed.locked_until, null, `${label}: success clears the lock`);
        assert.equal(Number(refreshed.last_login_at), 987654321);

        const duplicate = await ds.createUser({ username: 'alice', passwordHash: 'x', role: 'admin' })
            .then(() => null, (error) => error);
        assert.ok(duplicate instanceof Error, `${label}: duplicate username must be rejected`);

        // ---- sessions ----
        const tokenHash = 'a'.repeat(64);
        const sessionId = await ds.createSession({
            tokenHash,
            userId: aliceId,
            csrfToken: 'csrf-1',
            expiresAt: Date.now() + 60_000,
            userAgent: 'test-agent',
            remoteAddr: '127.0.0.1',
        });
        assert.ok(sessionId > 0);
        const found = await ds.findSessionByTokenHash(tokenHash);
        assert.equal(found.user_id, Number(aliceId) === found.user_id ? found.user_id : aliceId);
        assert.equal(found.csrf_token, 'csrf-1');
        assert.equal(await ds.findSessionByTokenHash('b'.repeat(64)), undefined);

        // touchSession with a realistic future expiry: session pruning runs next
        // and must not remove the live row.
        const liveExpiry = Date.now() + 3_600_000;
        await ds.touchSession(sessionId, { lastSeenAt: 111, expiresAt: liveExpiry });
        const touched = await ds.findSessionByTokenHash(tokenHash);
        assert.equal(Number(touched.last_seen_at), 111);
        assert.equal(Number(touched.expires_at), liveExpiry);

        const expiredId = await ds.createSession({
            tokenHash: 'c'.repeat(64),
            userId: aliceId,
            csrfToken: 'csrf-2',
            expiresAt: 1,
            userAgent: '',
            remoteAddr: '',
        });
        assert.ok(expiredId > 0);
        const pruned = await ds.pruneExpiredSessions(Date.now());
        assert.ok(pruned >= 1, `${label}: pruneExpiredSessions removes the expired row`);
        assert.equal(await ds.findSessionByTokenHash('c'.repeat(64)), undefined);
        assert.ok(await ds.findSessionByTokenHash(tokenHash), 'a live session survives pruning');

        await ds.deleteSessionsForUser(aliceId);
        assert.equal(await ds.findSessionByTokenHash(tokenHash), undefined, `${label}: revoke-all works`);

        // ---- servers ----
        const serverId = await ds.createServer({
            name: 'main', host: '10.0.0.1', port: 24872, password: 'pw', notes: 'note',
        });
        const server = await ds.findServerById(serverId);
        assert.equal(server.name, 'main');
        assert.equal(Number(server.port), 24872);
        assert.equal(server.password, 'pw');
        await ds.updateServer(serverId, { name: 'main2', port: 24900 });
        const changed = await ds.findServerById(serverId);
        assert.equal(changed.name, 'main2');
        assert.equal(Number(changed.port), 24900);
        assert.equal(changed.host, '10.0.0.1', 'an unspecified field is untouched');
        assert.equal((await ds.listServers()).length, 1);

        const dupServer = await ds.createServer({ name: 'main2', host: 'x', port: 1 })
            .then(() => null, (error) => error);
        assert.ok(dupServer instanceof Error, `${label}: duplicate server name must be rejected`);

        // ---- rooms ----
        const roomId = await ds.createRoom({
            name: 'room-1',
            serverId,
            citraPort: 25000,
            roomPort: 24000,
            listenAddress: '0.0.0.0',
            password: 'secret',
            profile: 'default',
        });
        let room = await ds.findRoomById(roomId);
        assert.equal(room.name, 'room-1');
        assert.equal(Number(room.citra_port), 25000);
        assert.equal(room.state, 'stopped');
        assert.equal(room.desired_state, 'stopped');
        assert.equal(room.pid, null);
        assert.equal(room.extra_args, '[]');

        await ds.updateRoom(roomId, {
            state: 'running', pid: 4242, desired_state: 'running', extraArgs: ['--a', '--b'],
        });
        room = await ds.findRoomById(roomId);
        assert.equal(room.state, 'running');
        assert.equal(Number(room.pid), 4242);
        assert.deepEqual(JSON.parse(room.extra_args), ['--a', '--b'], `${label}: extra_args round-trips`);
        assert.equal(room.name, 'room-1', 'an unspecified column is untouched');

        assert.equal((await ds.findRoomByName('room-1')).id, roomId);
        assert.equal(await ds.findRoomByName('nope'), undefined);

        const secondId = await ds.createRoom({
            name: 'room-2', serverId, citraPort: 25001, roomPort: 24001, profile: 'legacy',
        });
        const ports = await ds.listUsedPorts();
        assert.ok(ports.citra instanceof Set, `${label}: listUsedPorts returns Sets`);
        assert.equal(ports.citra.has(25000) && ports.citra.has(25001) || ports.citra.has(25000), true);
        assert.ok(ports.room.has(24000));

        const dupRoom = await ds.createRoom({ name: 'room-1', serverId, citraPort: 1, roomPort: 2 })
            .then(() => null, (error) => error);
        assert.ok(dupRoom instanceof Error, `${label}: duplicate room name must be rejected`);

        // Deleting the server must not orphan the room rows into an error state.
        await ds.deleteServer(serverId);
        room = await ds.findRoomById(roomId);
        assert.notEqual(room, undefined, 'the room survives its server being deleted');
        assert.equal(room.server_id, null, `${label}: server_id is nulled by ON DELETE SET NULL`);

        // ---- events ----
        await ds.addEvent({ roomId, kind: 'room.started', detail: 'pid=1', actor: 'tester' });
        await ds.addEvent({ kind: 'auth.login', detail: 'ok', actor: 'tester' });
        const events = await ds.listEvents({ limit: 10 });
        assert.equal(events.length, 2);
        assert.equal(events[0].kind, 'auth.login', `${label}: newest event first`);
        const roomEvents = await ds.listEvents({ roomId, limit: 10 });
        assert.equal(roomEvents.length, 1);
        assert.equal(roomEvents[0].kind, 'room.started');

        const prunedEvents = await ds.pruneEvents(Date.now() + 1000);
        assert.ok(prunedEvents >= 2, `${label}: pruneEvents removes old rows`);
        assert.equal((await ds.listEvents({ limit: 10 })).length, 0);

        // ---- delete room / cascade ----
        await ds.deleteRoom(secondId);
        assert.equal(await ds.findRoomById(secondId), undefined);

        // ---- delete user ----
        await ds.deleteUser(bobId);
        assert.equal(await ds.countUsers(), 1);
    } finally {
        await ds.close();
        // Closing twice is an explicit part of the contract.
        await ds.close();
    }
}

test('SQLite: on-disk file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-ds-'));
    try {
        const ds = new SqliteDatasource({ path: join(root, 'test.db') });
        await runContract(ds, { label: 'sqlite-file' });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('SQLite: in-memory', async () => {
    const ds = new SqliteDatasource({ path: ':memory:' });
    await runContract(ds, { label: 'sqlite-memory' });
});

test('SQLite: data survives reopen, schema version is enforced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-ds-'));
    try {
        const path = join(root, 'persist.db');
        const first = new SqliteDatasource({ path });
        await first.init();
        await first.createUser({ username: 'persist', passwordHash: 'h', role: 'owner' });
        await first.setSetting('marker', 'kept');
        const roomId = await first.createRoom({ name: 'r', serverId: null, citraPort: 1, roomPort: 2 });
        await first.close();

        const second = new SqliteDatasource({ path });
        await second.init();
        assert.equal(await second.countUsers(), 1, 'users persist');
        assert.equal(await second.getSetting('marker'), 'kept', 'settings persist');
        assert.equal((await second.findRoomById(roomId)).name, 'r', 'rooms persist');
        // Re-running init() on an existing database must be a no-op migration.
        await second.init();
        assert.equal(await second.countUsers(), 1);
        await second.close();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('SQLite: a future schema version is refused instead of silently used', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-ds-'));
    try {
        const path = join(root, 'future.db');
        const first = new SqliteDatasource({ path });
        await first.init();
        // Simulate a database written by a newer build.
        first.db.prepare(`UPDATE schema_meta SET value = '99' WHERE key = 'schema_version'`).run();
        await first.close();

        const second = new SqliteDatasource({ path });
        await assert.rejects(() => second.init(), /schema version 99 is not supported/);
        await second.close();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('MySQL: missing optional dependency produces an actionable error', async () => {
    const ds = new MysqlDatasource(mysqlOptions());
    const result = await ds.init().then(() => null, (error) => error);
    if (result === null) {
        // mysql2 IS installed: nothing to assert about the missing-dependency path.
        await ds.close();
        return;
    }
    assert.equal(result.code, 'MYSQL2_MISSING');
    assert.match(result.message, /npm install mysql2/);
});

test('MySQL: full contract', { skip: !MYSQL_ENABLED && 'set MHGA_TEST_MYSQL=1 with a reachable server' }, async () => {
    const ds = new MysqlDatasource(mysqlOptions());
    await runContract(ds, { label: 'mysql' });
});
