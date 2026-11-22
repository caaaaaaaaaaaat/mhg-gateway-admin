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

        // ---- mappings ----
        // One row is one pair: a local port and the upstream server it forwards to.
        const mappingId = await ds.createMapping({
            name: 'map-1',
            localPort: 25000,
            targetHost: 'www.example.com',
            targetPort: 9901,
            password: 'pw',
            notes: 'note',
        });
        let mapping = await ds.findMappingById(mappingId);
        assert.equal(mapping.name, 'map-1');
        assert.equal(Number(mapping.local_port), 25000);
        assert.equal(mapping.target_host, 'www.example.com', `${label}: target host round-trips`);
        assert.equal(Number(mapping.target_port), 9901, `${label}: target port round-trips`);
        assert.equal(mapping.password, 'pw');
        // capacity is deprecated: the room reports its own member_slots, so the column
        // exists only so an older database still opens.
        assert.equal(Number(mapping.capacity), 0, `${label}: capacity is not configured`);
        assert.equal(mapping.state, 'stopped');
        assert.equal(mapping.desired_state, 'stopped');
        assert.equal(mapping.pid, null);
        assert.equal(mapping.extra_args, '[]');

        // Camel-case update fields must land on their snake_case columns.
        await ds.updateMapping(mappingId, {
            state: 'running',
            pid: 4242,
            extraArgs: ['--a', '--b'],
            targetPort: 9902,
        });
        mapping = await ds.findMappingById(mappingId);
        assert.equal(mapping.state, 'running');
        assert.equal(Number(mapping.pid), 4242);
        assert.deepEqual(JSON.parse(mapping.extra_args), ['--a', '--b'], `${label}: extra_args round-trips`);
        assert.equal(Number(mapping.target_port), 9902, `${label}: targetPort alias reaches target_port`);
        assert.equal(mapping.name, 'map-1', 'an unspecified column is untouched');

        assert.equal((await ds.findMappingByName('map-1')).id, mappingId);
        assert.equal(await ds.findMappingByName('nope'), undefined);

        const secondId = await ds.createMapping({
            name: 'map-2',
            localPort: 25001,
            targetHost: '10.0.0.2',
            targetPort: 24872,
            profile: 'legacy',
        });
        const usedPorts = await ds.listUsedLocalPorts();
        assert.ok(Array.isArray(usedPorts), `${label}: listUsedLocalPorts returns an array`);
        assert.ok(usedPorts.includes(25000) && usedPorts.includes(25001), `${label}: both local ports are listed`);

        // The local port is UNIQUE: two mappings may not claim the same one.
        const dupPort = await ds.createMapping({ name: 'map-3', localPort: 25000, targetHost: 'x', targetPort: 1 })
            .then(() => null, (error) => error);
        assert.ok(dupPort instanceof Error, `${label}: duplicate local_port must be rejected`);

        const dupName = await ds.createMapping({ name: 'map-1', localPort: 25999, targetHost: 'x', targetPort: 1 })
            .then(() => null, (error) => error);
        assert.ok(dupName instanceof Error, `${label}: duplicate mapping name must be rejected`);

        // ---- events ----
        await ds.addEvent({ mappingId, kind: 'mapping.started', detail: 'pid=1', actor: 'tester' });
        await ds.addEvent({ kind: 'auth.login', detail: 'ok', actor: 'tester' });
        const events = await ds.listEvents({ limit: 10 });
        assert.equal(events.length, 2);
        assert.equal(events[0].kind, 'auth.login', `${label}: newest event first`);
        const mappingEvents = await ds.listEvents({ mappingId, limit: 10 });
        assert.equal(mappingEvents.length, 1);
        assert.equal(mappingEvents[0].kind, 'mapping.started');
        assert.equal(Number(mappingEvents[0].mapping_id), Number(mappingId), `${label}: event carries mapping_id`);

        const prunedEvents = await ds.pruneEvents(Date.now() + 1000);
        assert.ok(prunedEvents >= 2, `${label}: pruneEvents removes old rows`);
        assert.equal((await ds.listEvents({ limit: 10 })).length, 0);

        // ---- delete mapping ----
        await ds.deleteMapping(secondId);
        assert.equal(await ds.findMappingById(secondId), undefined);
        assert.equal((await ds.listUsedLocalPorts()).includes(25001), false, 'deleting frees the local port');


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
        const mappingId = await first.createMapping({
            name: 'r', localPort: 25000, targetHost: '1.2.3.4', targetPort: 9901,
        });
        await first.close();

        const second = new SqliteDatasource({ path });
        await second.init();
        assert.equal(await second.countUsers(), 1, 'users persist');
        assert.equal(await second.getSetting('marker'), 'kept', 'settings persist');
        assert.equal((await second.findMappingById(mappingId)).name, 'r', 'mappings persist');
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
        await assert.rejects(() => second.init(), /schema version 99 is newer than this build supports/);
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
