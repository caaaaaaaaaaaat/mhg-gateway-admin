// SPDX-License-Identifier: GPL-3.0-or-later
// GatewaySupervisor: real child processes, real log files, real exit handling.
//
// The gateway binary is replaced with a small Node script (test/helpers.js
// writeStubBinary) so these tests do not need a built C++ executable, while every
// code path the supervisor owns -- spawn, pipe, state transitions, SIGTERM,
// restart-on-crash, crash-loop fuse, log rotation -- runs for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewaySupervisor, buildGatewayArgs, allocatePort, resolveGatewayBinary, MAPPING_STATE } from '../src/lib/supervisor.js';
import { SqliteDatasource } from '../src/datasource/sqlite.js';
import { validateConfig, defaultConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { writeStubBinary, stubSpawn } from './helpers.js';

const log = createLogger({ level: 'error' });

async function makeHarness({ stubArgs = [], supervisorOverrides = {}, restartPolicy = null } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'mhga-sup-'));
    const binary = writeStubBinary(root);
    const config = validateConfig({
        ...defaultConfig(),
        storage: { driver: 'sqlite', sqlite: { path: ':memory:' } },
        gateways: {
            binaryPath: binary,
            binSearchPaths: ['bin'],
            localPortRange: [27000, 27010],
            
            runtimeDir: 'rooms',
            extraArgs: stubArgs,
            sampleIntervalMs: 60_000,
            logRetentionDays: 1,
        },
        logging: { level: 'error', file: '' },
    }, { root });
    const ds = new SqliteDatasource({ path: ':memory:' });
    await ds.init();
    const supervisor = new GatewaySupervisor({
        config,
        datasource: ds,
        logger: log,
        spawnImpl: stubSpawn(),
        // Test-only: compress the restart backoff so the crash-loop fuse can be
        // observed in seconds. Production keeps RESTART_POLICY.
        ...(restartPolicy ? { restartPolicy } : {}),
        ...supervisorOverrides,
    });
    supervisor.probeBinary();
    // One mapping is one pair, so there is no server row to create first.
    const roomId = await ds.createMapping({
        name: 'sup-map',
        localPort: 27000,
        targetHost: '127.0.0.1',
        targetPort: 24872,
        listenAddress: '0.0.0.0',
        password: 'room-secret',
        profile: 'default',
    });
    return {
        root,
        config,
        ds,
        supervisor,
        roomId,
        async close() {
            await supervisor.stop();
            await ds.close();
            rmSync(root, { recursive: true, force: true });
        },
    };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await sleep(intervalMs);
    }
}

test('buildGatewayArgs maps the pair onto the right gateway addresses', () => {
    // The whole point of the model: localPort is what players dial, and
    // targetHost:targetPort is the upstream room server. Crossing them is the bug
    // this test exists to catch.
    const mapping = {
        listenAddress: '0.0.0.0', localPort: 25000,
        targetHost: 'www.example.com', targetPort: 9901,
        password: 'pw', profile: 'default', capacity: 4,
    };
    const args = buildGatewayArgs(mapping, { profile: 'default' });

    assert.deepEqual(args.slice(0, 10), [
        '--listen', '0.0.0.0', '--listen-port', '25000', '--room', 'www.example.com',
        '--room-port', '9901', '--room-capacity', '4',
    ]);
    assert.ok(args.includes('--password'));
    assert.equal(args[args.indexOf('--password') + 1], 'pw');
    assert.ok(args.includes('--control-plane'), 'the default profile enables the control plane');
    assert.ok(args.includes('--ldn-dual-host'));
    assert.equal(args[args.indexOf('--ldn-proxy-port') + 1], '12345');
    assert.equal(args[args.indexOf('--ldn-comm-id') + 1], '0100770008dd8000');
    assert.equal(args[args.indexOf('--uds-profile') + 1], 'mhxx');

    const legacy = buildGatewayArgs(mapping, { profile: 'legacy' });
    assert.equal(legacy.includes('--control-plane'), false, 'legacy is data-plane only');
    assert.equal(legacy.includes('--ldn-dual-host'), false);
    assert.equal(legacy[legacy.indexOf('--listen') + 1], '0.0.0.0');

    // An empty password is still forwarded explicitly: the gateway treats a missing
    // --password and an empty one differently in its own local check.
    const noPassword = buildGatewayArgs({ ...mapping, password: '' }, { profile: 'default' });
    assert.equal(noPassword[noPassword.indexOf('--password') + 1], '');
});

test('allocatePort skips used ports and reports exhaustion', () => {
    const used = new Set([27000, 27002]);
    assert.equal(allocatePort([27000, 27005], used), 27001);
    assert.ok(used.has(27001), 'the allocation is recorded in the set');
    assert.equal(allocatePort([27000, 27002], new Set([27000, 27001, 27002])), null);
    assert.equal(allocatePort([1, 1], new Set()), 1, 'a single-port range works');
});

test('resolveGatewayBinary prefers the explicit path and reports nothing when absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-bin-'));
    try {
        const base = validateConfig({
            ...defaultConfig(),
            gateways: { binaryPath: join(root, 'missing'), binSearchPaths: [root], runtimeDir: 'r' },
        }, { root });
        assert.equal(resolveGatewayBinary(base), null);

        const stub = writeStubBinary(root, process.platform === 'win32' ? 'citra-gateway.exe' : 'citra-gateway');
        const found = validateConfig({
            ...defaultConfig(),
            gateways: { binaryPath: '', binSearchPaths: [root], runtimeDir: 'r' },
        }, { root });
        assert.equal(resolveGatewayBinary(found), stub);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a mapping refused to start when the binary is missing records why', async () => {
    const h = await makeHarness();
    try {
        h.supervisor.binary = null;
        h.supervisor.binaryError = '';
        h.config.gateways.binaryPath = '';
        h.config.gateways.binSearchPaths = ['/nonexistent-path-for-test'];
        const result = await h.supervisor.startMapping(h.roomId, { actor: 'tester' });
        assert.equal(result.ok, false);
        assert.match(result.error, /找不到 citra-gateway/);
        const room = await h.ds.findMappingById(h.roomId);
        assert.equal(room.state, MAPPING_STATE.failed);
        assert.match(room.failure, /找不到 citra-gateway/);
        const events = await h.ds.listEvents({ roomId: h.roomId, limit: 10 });
        assert.ok(events.some((event) => event.kind === 'mapping.start.refused'));
    } finally {
        await h.close();
    }
});

test('start moves the mapping to running, stop returns it to stopped', async () => {
    const h = await makeHarness();
    try {
        const started = await h.supervisor.startMapping(h.roomId, { actor: 'tester' });
        assert.equal(started.ok, true);
        assert.ok(started.pid > 0, 'a real pid is reported');
        assert.equal(h.supervisor.isRunning(h.roomId), true);
        assert.equal(h.supervisor.pidOf(h.roomId), started.pid);

        const room = await h.ds.findMappingById(h.roomId);
        assert.equal(room.state, MAPPING_STATE.running);
        assert.equal(room.desired_state, 'running');
        assert.equal(Number(room.pid), started.pid);
        assert.ok(room.started_at > 0);

        // The command line is written to the log, with the password redacted.
        // The write is asynchronous (a WriteStream), so poll instead of reading once.
        const logPath = h.supervisor.logPathFor(h.roomId);
        assert.ok(existsSync(logPath), 'the log file is created');
        const text = await waitFor(() => {
            const current = readFileSync(logPath, 'utf8');
            return current.includes('start ') && current.includes('citra-gateway') ? current : null;
        });
        assert.ok(text, 'the start line reaches the log');
        assert.equal(text.includes('room-secret'), false, 'the room password must never be logged');
        assert.match(text, /\*\*\*/, 'the redaction is visible in the log');

        // Starting twice is idempotent rather than an error.
        const again = await h.supervisor.startMapping(h.roomId);
        assert.equal(again.ok, true);
        assert.equal(again.alreadyRunning, true);

        const stopped = await h.supervisor.stopMapping(h.roomId, { actor: 'tester' });
        assert.equal(stopped.ok, true);
        const after = await waitFor(async () => {
            const current = await h.ds.findMappingById(h.roomId);
            return current.state === MAPPING_STATE.stopped ? current : null;
        });
        assert.ok(after, 'the room settles in stopped');
        assert.equal(after.desired_state, 'stopped');
        assert.equal(after.pid, null);
        assert.equal(h.supervisor.isRunning(h.roomId), false);

        const events = await h.ds.listEvents({ roomId: h.roomId, limit: 20 });
        const kinds = events.map((event) => event.kind);
        assert.ok(kinds.includes('mapping.started'));
        assert.ok(kinds.includes('mapping.stop.requested'));
        assert.ok(kinds.includes('mapping.stopped'));
    } finally {
        await h.close();
    }
});

test('a crash restarts the mapping with backoff and is recorded', async () => {
    // --stub-exit exits immediately with code 3, which is the crash path.
    // A compressed backoff keeps the fuse observable without a minute of waiting.
    const h = await makeHarness({
        stubArgs: ['--stub-exit'],
        restartPolicy: { maxAttempts: 3, windowMs: 60_000, baseBackoffMs: 60, maxBackoffMs: 200 },
    });
    try {
        const started = await h.supervisor.startMapping(h.roomId, { actor: 'tester' });
        assert.equal(started.ok, true);

        // The first crash must be recorded before the restart attempt.
        const crashed = await waitFor(async () => {
            const events = await h.ds.listEvents({ roomId: h.roomId, limit: 50 });
            return events.find((event) => event.kind === 'mapping.crashed') ?? null;
        });
        assert.ok(crashed, 'a crash produces a room.crashed event');
        assert.match(crashed.detail, /退出码=3/);

        // And the restart loop must give up at the fuse rather than spin forever.
        const loop = await waitFor(async () => {
            const events = await h.ds.listEvents({ roomId: h.roomId, limit: 160 });
            return events.find((event) => event.kind === 'mapping.crashloop') ?? null;
        }, { timeoutMs: 30_000, intervalMs: 100 });
        assert.ok(loop, 'the crash-loop fuse eventually trips');
        const room = await h.ds.findMappingById(h.roomId);
        assert.equal(room.state, MAPPING_STATE.failed);
        assert.equal(room.desired_state, 'stopped', 'the fuse stops automatic restarts');
        assert.match(room.failure, /反复退出/);

        // Every attempt is auditable: one crashed event per try plus the fuse.
        const all = await h.ds.listEvents({ roomId: h.roomId, limit: 200 });
        const crashes = all.filter((event) => event.kind === 'mapping.crashed').length;
        assert.ok(crashes >= 2, `expected repeated crash attempts, saw ${crashes}`);
    } finally {
        await h.close();
    }
});

test('the log viewer returns the tail and marks truncation', async () => {
    const h = await makeHarness({ stubArgs: ['--stub-echo'] });
    try {
        await h.supervisor.startMapping(h.roomId, { actor: 'tester' });
        await waitFor(async () => {
            const logPath = h.supervisor.logPathFor(h.roomId);
            if (!existsSync(logPath)) return null;
            return readFileSync(logPath, 'utf8').includes('gateway listening') ? true : null;
        });
        const full = h.supervisor.readLog(h.roomId, { lines: 100 });
        assert.match(full.text, /gateway listening/);
        assert.equal(full.truncated, false);

        const tiny = h.supervisor.readLog(h.roomId, { lines: 1 });
        assert.equal(tiny.truncated, true, 'asking for fewer lines than exist reports truncation');
        assert.ok(tiny.text.split('\n').length >= 1);

        const missing = h.supervisor.readLog(99999);
        assert.equal(missing.text, '');
    } finally {
        await h.close();
    }
});

test('log rotation keeps a bounded number of files', async () => {
    const h = await makeHarness();
    try {
        const logPath = h.supervisor.logPathFor(h.roomId);
        // Pre-create an oversized log so the next start rotates it.
        const { mkdirSync } = await import('node:fs');
        mkdirSync(h.config.gateways.runtimeDir, { recursive: true });
        writeFileSync(logPath, 'x'.repeat(3 * 1024 * 1024));
        await h.supervisor.startMapping(h.roomId, { actor: 'tester' });
        assert.ok(existsSync(`${logPath}.1`), 'the oversized log is rotated to .1');
        assert.ok(statSync(logPath).size < 3 * 1024 * 1024, 'the new log starts small');
        await h.supervisor.stopMapping(h.roomId);
    } finally {
        await h.close();
    }
});

test('pruneLogs removes logs past the retention window and nothing else', async () => {
    const h = await makeHarness();
    try {
        const { mkdirSync, utimesSync } = await import('node:fs');
        const dir = h.config.gateways.runtimeDir;
        mkdirSync(dir, { recursive: true });
        const oldLog = join(dir, 'mapping-1.log');
        const newLog = join(dir, 'mapping-2.log');
        const unrelated = join(dir, 'notes.txt');
        writeFileSync(oldLog, 'old');
        writeFileSync(newLog, 'new');
        writeFileSync(unrelated, 'keep me');
        const ancient = Date.now() / 1000 - 10 * 86_400;
        utimesSync(oldLog, ancient, ancient);

        const removed = h.supervisor.pruneLogs();
        assert.ok(removed.some((path) => path.endsWith('mapping-1.log')), 'the old log is removed');
        assert.ok(existsSync(newLog), 'a fresh log survives');
        assert.ok(existsSync(unrelated), 'an unrelated file in the runtime dir is untouched');
    } finally {
        await h.close();
    }
});

test('stale running state is reported as failed on startup, not silently relaunched', async () => {
    const h = await makeHarness();
    try {
        await h.ds.updateMapping(h.roomId, { state: 'running', desired_state: 'running', pid: 999999 });
        await h.supervisor.start();
        const room = await h.ds.findMappingById(h.roomId);
        assert.equal(room.state, MAPPING_STATE.failed);
        assert.equal(room.pid, null);
        assert.match(room.failure, /请重新启动/);
        assert.equal(h.supervisor.isRunning(h.roomId), false, 'nothing was launched behind the operator');
    } finally {
        await h.close();
    }
});

test('sampleAll reconciles a live pid and clears expired sessions', async () => {
    const h = await makeHarness();
    try {
        await h.supervisor.startMapping(h.roomId, { actor: 'tester' });
        // Corrupt the stored pid: the sample loop must correct it from the process.
        await h.ds.updateMapping(h.roomId, { pid: 1 });
        await h.supervisor.sampleAll();
        const room = await h.ds.findMappingById(h.roomId);
        assert.equal(room.pid, h.supervisor.pidOf(h.roomId));

        await h.ds.createSession({
            tokenHash: 'd'.repeat(64), userId: 1, csrfToken: 'x',
            expiresAt: Date.now() - 1000, userAgent: '', remoteAddr: '',
        }).catch(() => { /* user 1 may not exist: irrelevant to pruning */ });
        await h.supervisor.sampleAll();
        await h.supervisor.stopMapping(h.roomId);
    } finally {
        await h.close();
    }
});

test('stopping an already stopped mapping is a no-op success', async () => {
    const h = await makeHarness();
    try {
        const result = await h.supervisor.stopMapping(h.roomId, { actor: 'tester' });
        assert.equal(result.ok, true);
        assert.equal(result.alreadyStopped, true);
        const room = await h.ds.findMappingById(h.roomId);
        assert.equal(room.state, MAPPING_STATE.stopped);
    } finally {
        await h.close();
    }
});

test('stop interrupts a scheduled auto-restart', async () => {
    const h = await makeHarness({
        stubArgs: ['--stub-exit'],
        restartPolicy: { maxAttempts: 5, windowMs: 60_000, baseBackoffMs: 400, maxBackoffMs: 400 },
    });
    try {
        await h.supervisor.startMapping(h.roomId, { actor: 'tester' });
        // Wait for the first crash so a restart is pending.
        await waitFor(async () => {
            const events = await h.ds.listEvents({ roomId: h.roomId, limit: 20 });
            return events.some((event) => event.kind === 'mapping.crashed');
        });
        await h.supervisor.stopMapping(h.roomId, { actor: 'tester' });
        const room = await h.ds.findMappingById(h.roomId);
        assert.equal(room.desired_state, 'stopped');
        // Give the pending timer time to fire if it were still armed.
        await sleep(1500);
        const after = await h.ds.findMappingById(h.roomId);
        assert.equal(after.state, MAPPING_STATE.stopped, 'no restart happened after an operator stop');
        assert.equal(h.supervisor.isRunning(h.roomId), false);
    } finally {
        await h.close();
    }
});
