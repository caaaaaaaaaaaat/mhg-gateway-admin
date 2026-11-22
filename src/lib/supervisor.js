// SPDX-License-Identifier: GPL-3.0-or-later
// Gateway process supervisor.
//
// Responsibilities, in the order they matter for an operator:
//   1. One managed gateway process per room, spawned from the configured binary
//      with an explicit argument list (no shell, no string concatenation), so a
//      room name can never become a command.
//   2. A single sample loop that keeps every room's live state fresh instead of
//      one timer per room.
//   3. Restart-on-crash with bounded backoff and a crash-loop fuse, because a
//      gateway that dies instantly (bad port, missing binary) must not spin.
//   4. Bounded, rotated log files per room, and the last lines readable through
//      the API for the web console.
//
// Deliberately NOT here: protocol translation. The supervisor only launches the
// gateway binary the crossplay project already provides.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, renameSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export const ROOM_STATE = Object.freeze({
    stopped: 'stopped',
    starting: 'starting',
    running: 'running',
    stopping: 'stopping',
    failed: 'failed',
});

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_KEEP = 3;
/**
 * Restart policy. These are module constants rather than config values because
 * they encode safety properties (never spin, never give up silently); the tests
 * inject shorter values through the constructor instead of loosening them.
 */
export const RESTART_POLICY = Object.freeze({
    maxAttempts: 5,
    windowMs: 60_000,
    baseBackoffMs: 1000,
    maxBackoffMs: 30_000,
});
const TAIL_BYTES = 64 * 1024;

function nowMs() {
    return Date.now();
}

/**
 * The CLI argument list for one room.
 *
 * The gateway's own defaults are loopback-only and its dual-host features are
 * opt-in, so a server deployment must state everything explicitly. Kept in one
 * function so a future gateway flag is added in exactly one place.
 */
export function buildGatewayArgs(room, server, { profile = 'default' } = {}) {
    const args = [
        '--listen', room.listenAddress || '0.0.0.0',
        '--listen-port', String(room.citraPort),
        '--room', server.host,
        '--room-port', String(room.roomPort),
        '--room-capacity', '4',
        // Room password is forwarded to the room and enforced locally too.
        '--password', room.password ?? '',
    ];
    if (profile === 'legacy') {
        // Data-plane relay only: no control plane, no dual-host. Useful as a
        // fallback when the MH translation layer misbehaves, and as a smaller
        // attack surface.
        return args;
    }
    // 'dual-host' (and 'default'): full MHXX/MHGU translation. These are the
    // exact values gateway-gui/src/backend.cpp uses for the desktop build.
    args.push(
        '--control-plane',
        '--ldn-dual-host',
        '--ldn-proxy-port', '12345',
        '--ldn-comm-id', '0100770008dd8000',
        '--uds-profile', 'mhxx',
    );
    return args;
}

/** Resolve the gateway binary: explicit path wins, then a search of bin paths. */
export function resolveGatewayBinary(config) {
    if (config.gateways.binaryPath) {
        return existsSync(config.gateways.binaryPath) ? config.gateways.binaryPath : null;
    }
    const names = process.platform === 'win32' ? ['citra-gateway.exe'] : ['citra-gateway'];
    for (const dir of config.gateways.binSearchPaths) {
        for (const name of names) {
            const candidate = join(dir, name);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/** Pick the first free port inside a range, skipping anything already used. */
export function allocatePort(range, used) {
    const [low, high] = range;
    for (let port = low; port <= high; port += 1) {
        if (!used.has(port)) {
            used.add(port);
            return port;
        }
    }
    return null;
}

/** Read at most `maxBytes` from the end of a file. */
function readTail(path, maxBytes = TAIL_BYTES) {
    let fd;
    try {
        const size = statSync(path).size;
        const start = Math.max(0, size - maxBytes);
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch { /* already closed */ }
        }
    }
}

export class GatewaySupervisor extends EventEmitter {
    /**
     * @param {object} options
     * @param {object} options.config      validated config
     * @param {object} options.datasource  Datasource instance
     * @param {object} options.logger
     */
    constructor({ config, datasource, logger, spawnImpl = spawn, restartPolicy = RESTART_POLICY }) {
        super();
        this.config = config;
        this.ds = datasource;
        this.logger = logger;
        this.spawnImpl = spawnImpl;
        this.restartPolicy = { ...RESTART_POLICY, ...restartPolicy };
        /** @type {Map<number, {proc: import('node:child_process').ChildProcess, stream: import('node:fs').WriteStream, restartTimes: number[], exitTimer: NodeJS.Timeout|null}>} */
        this.procs = new Map();
        /**
         * Pending auto-restart timers, keyed by room id.
         * They live outside `procs` because the process entry is deleted as soon as
         * the child exits, while the restart timer it armed is still outstanding;
         * stopRoom must be able to cancel it or a stopped room comes back.
         * @type {Map<number, NodeJS.Timeout>}
         */
        this.restartTimers = new Map();
        /**
         * Crash timestamps per room, for the crash-loop fuse.
         *
         * These MUST NOT live on the process entry: every restart creates a new
         * entry, so per-entry history reset on each attempt and the fuse could
         * never trip (a room that crashes instantly would restart forever). Keyed
         * by room id, pruned to the policy window on each crash.
         * @type {Map<number, number[]>}
         */
        this.crashTimes = new Map();
        this.timer = null;
        this.binary = null;
        this.binaryError = '';
        this.sampleIntervalMs = config.gateways.sampleIntervalMs;
    }

    get runtimeDir() {
        return this.config.gateways.runtimeDir;
    }

    logPathFor(roomId) {
        return join(this.runtimeDir, `room-${roomId}.log`);
    }

    /** Locate the gateway binary once and remember why it was not found. */
    probeBinary() {
        this.binary = resolveGatewayBinary(this.config);
        if (this.binary) {
            this.binaryError = '';
            return this.binary;
        }
        this.binaryError = this.config.gateways.binaryPath
            ? `gateways.binaryPath 不存在: ${this.config.gateways.binaryPath}`
            : `在 ${this.config.gateways.binSearchPaths.join(', ')} 中找不到 citra-gateway` +
              (process.platform === 'win32' ? '.exe' : '');
        return null;
    }

    async start() {
        mkdirSync(this.runtimeDir, { recursive: true });
        this.probeBinary();
        // Adopt rooms that were left "running" by a crash of the console itself:
        // their pid is stale, so they are honestly reported as failed until an
        // operator starts them again. Do not silently relaunch: an operator may
        // have stopped the room on purpose just before the console died.
        const rooms = await this.ds.listRooms();
        for (const room of rooms) {
            if (room.desired_state === 'running' && room.state !== 'running') {
                await this.ds.updateRoom(room.id, {
                    state: ROOM_STATE.failed,
                    failure: '控制台重启前房间处于运行状态，请重新启动',
                    pid: null,
                });
            } else if (room.state === 'running') {
                await this.ds.updateRoom(room.id, {
                    state: ROOM_STATE.failed,
                    failure: '控制台重启，进程状态未知，请重新启动',
                    pid: null,
                });
            }
        }
        this.timer = setInterval(() => {
            this.sampleAll().catch((error) => {
                this.logger.error('sample loop failed', { error: error.message });
            });
        }, this.sampleIntervalMs);
        this.timer.unref?.();
    }

    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        for (const [roomId, timer] of this.restartTimers) {
            clearTimeout(timer);
            this.logger.debug('cancelled pending restart on shutdown', { roomId });
        }
        this.restartTimers.clear();
        const stops = [];
        for (const roomId of [...this.procs.keys()]) {
            stops.push(this.stopRoom(roomId, { reason: 'console-shutdown' }).catch(() => {}));
        }
        await Promise.all(stops);
    }

    isRunning(roomId) {
        const entry = this.procs.get(roomId);
        return Boolean(entry && entry.proc && entry.proc.exitCode === null && !entry.proc.killed);
    }

    /** Live pid for a room, or null. */
    pidOf(roomId) {
        const entry = this.procs.get(roomId);
        return entry && entry.proc && entry.proc.exitCode === null ? entry.proc.pid ?? null : null;
    }

    /**
     * Start one room. Refuses when the binary is missing or the room is already
     * running, and records a failure state instead of throwing for the
     * recoverable cases, because the operator needs to see *why* in the console.
     */
    async startRoom(roomId, { actor = 'system' } = {}) {
        const room = await this.ds.findRoomById(roomId);
        if (!room) throw Object.assign(new Error('房间不存在'), { statusCode: 404 });
        if (this.isRunning(roomId)) return { ok: true, alreadyRunning: true };

        const binary = this.binary ?? this.probeBinary();
        if (!binary) {
            await this.ds.updateRoom(roomId, {
                state: ROOM_STATE.failed,
                failure: this.binaryError,
                pid: null,
            });
            await this.ds.addEvent({
                roomId,
                kind: 'room.start.refused',
                detail: this.binaryError,
                actor,
            });
            return { ok: false, error: this.binaryError };
        }

        const server = room.server_id ? await this.ds.findServerById(room.server_id) : null;
        if (!server) {
            const message = '房间没有绑定可用的房间服务器，请先在“服务器”里配置并选择';
            await this.ds.updateRoom(roomId, { state: ROOM_STATE.failed, failure: message, pid: null });
            await this.ds.addEvent({ roomId, kind: 'room.start.refused', detail: message, actor });
            return { ok: false, error: message };
        }

        const args = [
            ...buildGatewayArgs(room, server, { profile: room.profile }),
            ...(Array.isArray(room.extra_args) ? room.extra_args : []),
            ...this.config.gateways.extraArgs,
        ];

        // An interpreter lets a packaged-as-script gateway run (and lets the
        // verification harness use a Node stub). Configuration normalises it to an
        // array of strings; an empty array means "exec the binary directly".
        const interpreter = Array.isArray(this.config.gateways.interpreter)
            ? this.config.gateways.interpreter
            : [];
        const command = interpreter.length ? interpreter[0] : binary;
        const argv = interpreter.length ? [...interpreter.slice(1), binary, ...args] : args;

        await this.ds.updateRoom(roomId, {
            state: ROOM_STATE.starting,
            failure: '',
            desired_state: 'running',
        });

        const logPath = this.logPathFor(roomId);
        this.#rotateLog(logPath);
        let stream;
        try {
            // The runtime directory may not exist yet on the very first start (for
            // example a fresh deployment that has never written a log). Creating it
            // here keeps a working start from failing on its own log file.
            mkdirSync(this.runtimeDir, { recursive: true });
            stream = createWriteStream(logPath, { flags: 'a' });
            // A stream error (disk full, permissions) must be handled, otherwise it
            // becomes an unhandled 'error' event and takes the whole console down.
            stream.on('error', (error) => {
                this.logger.error('room log stream failed', { roomId, path: logPath, error: error.message });
            });
        } catch (error) {
            const message = `无法打开房间日志: ${error.message}`;
            await this.ds.updateRoom(roomId, { state: ROOM_STATE.failed, failure: message, desired_state: 'stopped' });
            return { ok: false, error: message };
        }

        let proc;
        try {
            proc = this.spawnImpl(command, argv, {
                cwd: this.runtimeDir,
                // No shell: args are passed as an array and never re-parsed.
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            stream.end();
            const message = `启动网关失败: ${error.message}`;
            await this.ds.updateRoom(roomId, {
                state: ROOM_STATE.failed,
                failure: message,
                desired_state: 'stopped',
            });
            await this.ds.addEvent({ roomId, kind: 'room.start.failed', detail: message, actor });
            return { ok: false, error: message };
        }

        const entry = { proc, stream, exitTimer: null };
        this.procs.set(roomId, entry);

        // Never log the password itself: it appears in argv, and the log is served
        // to the browser. Redact it before writing anything.
        const printable = args.map((value) => (value === room.password && value ? '***' : value));
        stream.write(`# ${new Date().toISOString()} start ${binary} ${printable.join(' ')}\n`);

        proc.stdout?.on('data', (chunk) => stream.write(chunk));
        proc.stderr?.on('data', (chunk) => stream.write(chunk));

        // The spawn handler and the started-state write must both finish before
        // startRoom returns, otherwise the caller can observe `state: starting`
        // and conclude the start failed.
        let markRunning;
        const runningWritten = new Promise((resolve) => {
            markRunning = resolve;
        });

        proc.on('spawn', async () => {
            try {
                await this.ds.updateRoom(roomId, {
                    state: ROOM_STATE.running,
                    pid: proc.pid ?? null,
                    started_at: nowMs(),
                    failure: '',
                });
                await this.ds.addEvent({
                    roomId,
                    kind: 'room.started',
                    detail: `pid=${proc.pid ?? '?'}`,
                    actor,
                });
                this.emit('room', { roomId, state: ROOM_STATE.running });
            } finally {
                markRunning();
            }
        });

        proc.on('error', async (error) => {
            this.procs.delete(roomId);
            stream.write(`# spawn error: ${error.message}\n`);
            await this.ds.updateRoom(roomId, {
                state: ROOM_STATE.failed,
                failure: `启动失败: ${error.message}`,
                pid: null,
                desired_state: 'stopped',
            });
            await this.ds.addEvent({ roomId, kind: 'room.spawn.error', detail: error.message, actor });
            this.emit('room', { roomId, state: ROOM_STATE.failed });
        });

        proc.on('exit', (code, signal) => {
            this.#onExit(roomId, entry, code, signal).catch((error) => {
                this.logger.error('exit handling failed', { roomId, error: error.message });
            });
        });

        // Wait for the spawn event before reporting success: `proc.pid` is only
        // valid once the child exists, and the caller (API/UI) needs a real pid so
        // "start refused" and "started" are never confused.
        const spawned = await new Promise((resolve) => {
            if (proc.pid !== undefined) {
                resolve(true);
                return;
            }
            const timer = setTimeout(() => resolve(false), 5000);
            timer.unref?.();
            proc.once('spawn', () => {
                clearTimeout(timer);
                resolve(true);
            });
            proc.once('error', () => {
                clearTimeout(timer);
                resolve(false);
            });
            proc.once('exit', () => {
                clearTimeout(timer);
                // A process that exited immediately did spawn; the exit handler owns
                // the crash bookkeeping, so report the attempt as started.
                resolve(proc.pid !== undefined);
            });
        });
        if (!spawned) {
            return { ok: false, error: '网关进程未能启动（spawn 失败），请查看房间日志' };
        }
        // Wait for the running row: without this the API could answer 200 with a
        // room still marked `starting` and a null pid.
        await Promise.race([runningWritten, new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            timer.unref?.();
        })]);
        return { ok: true, pid: proc.pid ?? null };
    }

    async #onExit(roomId, entry, code, signal) {
        this.procs.delete(roomId);
        try {
            entry.stream.end();
        } catch { /* stream already closed */ }
        const room = await this.ds.findRoomById(roomId);
        if (!room) return;

        const stoppedByOperator = room.desired_state !== 'running';
        const detail = `退出码=${code ?? 'null'} 信号=${signal ?? 'none'}`;

        if (stoppedByOperator) {
            await this.ds.updateRoom(roomId, {
                state: ROOM_STATE.stopped,
                pid: null,
                stopped_at: nowMs(),
                failure: '',
            });
            await this.ds.addEvent({ roomId, kind: 'room.stopped', detail, actor: 'operator' });
            this.emit('room', { roomId, state: ROOM_STATE.stopped });
            return;
        }

        // Wanted to run but died: bounded restart with a crash-loop fuse.
        // The history lives on the supervisor (keyed by room), NOT on `entry`, because
        // every restart builds a fresh entry and would reset the counter forever.
        const now = nowMs();
        const history = (this.crashTimes.get(roomId) ?? [])
            .filter((t) => now - t < this.restartPolicy.windowMs);
        history.push(now);
        this.crashTimes.set(roomId, history);

        if (history.length > this.restartPolicy.maxAttempts) {
            await this.ds.updateRoom(roomId, {
                state: ROOM_STATE.failed,
                pid: null,
                failure: `短时间内反复退出（${history.length} 次/${Math.round(this.restartPolicy.windowMs / 1000)} 秒），已停止自动重试`,
                desired_state: 'stopped',
            });
            await this.ds.addEvent({
                roomId,
                kind: 'room.crashloop',
                detail: `${detail}（熔断，停止自动重启）`,
                actor: 'system',
            });
            this.emit('room', { roomId, state: ROOM_STATE.failed });
            return;
        }

        await this.ds.updateRoom(roomId, {
            state: ROOM_STATE.failed,
            pid: null,
            failure: `网关进程意外退出（${detail}），正在重启`,
        });
        await this.ds.addEvent({
            roomId,
            kind: 'room.crashed',
            detail: `${detail}（第 ${history.length} 次，准备重启）`,
            actor: 'system',
        });
        this.emit('room', { roomId, state: ROOM_STATE.failed });

        const backoffMs = Math.min(
            this.restartPolicy.maxBackoffMs,
            this.restartPolicy.baseBackoffMs * 2 ** (history.length - 1),
        );
        const restartTimer = setTimeout(() => {
            this.restartTimers.delete(roomId);
            // Re-check the operator's intent: a stop arriving during the backoff
            // must win over the crash-recovery schedule.
            this.ds.findRoomById(roomId).then((current) => {
                if (!current || current.desired_state !== 'running') return;
                return this.startRoom(roomId, { actor: 'system-auto-restart' });
            }).catch(() => {});
        }, backoffMs);
        restartTimer.unref?.();
        this.restartTimers.set(roomId, restartTimer);
        entry.exitTimer = restartTimer;
    }

    /** Stop one room gracefully: SIGTERM, then SIGKILL after a grace period. */
    async stopRoom(roomId, { actor = 'operator', reason = '' } = {}) {
        const room = await this.ds.findRoomById(roomId);
        if (!room) throw Object.assign(new Error('房间不存在'), { statusCode: 404 });
        await this.ds.updateRoom(roomId, { desired_state: 'stopped' });
        // Cancel a pending auto-restart first: it is the one thing that could bring
        // the room back after the operator asked for it to stay down.
        const pendingRestart = this.restartTimers.get(roomId);
        if (pendingRestart) {
            clearTimeout(pendingRestart);
            this.restartTimers.delete(roomId);
        }
        const entry = this.procs.get(roomId);
        if (!entry || entry.proc.exitCode !== null) {
            await this.ds.updateRoom(roomId, {
                state: ROOM_STATE.stopped,
                pid: null,
                stopped_at: nowMs(),
                failure: '',
            });
            return { ok: true, alreadyStopped: true };
        }
        if (entry.exitTimer) {
            clearTimeout(entry.exitTimer);
            entry.exitTimer = null;
        }
        this.restartTimers.delete(roomId);
        await this.ds.updateRoom(roomId, { state: ROOM_STATE.stopping });
        await this.ds.addEvent({
            roomId,
            kind: 'room.stop.requested',
            detail: reason,
            actor,
        });

        const proc = entry.proc;
        proc.kill('SIGTERM');
        const killed = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch { /* already dead */ }
                resolve(false);
            }, 5000);
            timer.unref?.();
            proc.once('exit', () => {
                clearTimeout(timer);
                resolve(true);
            });
        });
        return { ok: true, graceful: killed };
    }

    /** Wait for a room to leave `starting` and report its settled state. */
    async waitForState(roomId, predicate, timeoutMs = 5000) {
        const deadline = nowMs() + timeoutMs;
        for (;;) {
            const room = await this.ds.findRoomById(roomId);
            if (room && predicate(room)) return room;
            if (nowMs() >= deadline) return room ?? null;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    /** One pass of the sample loop: reconcile live pids with stored state. */
    async sampleAll() {
        const rooms = await this.ds.listRooms();
        for (const room of rooms) {
            const live = this.isRunning(room.id);
            if (room.state === ROOM_STATE.running && !live) {
                await this.ds.updateRoom(room.id, {
                    state: ROOM_STATE.failed,
                    pid: null,
                    failure: room.failure || '进程已不在运行',
                });
            } else if (room.state === ROOM_STATE.running && live) {
                const pid = this.pidOf(room.id);
                if (pid && room.pid !== pid) await this.ds.updateRoom(room.id, { pid });
            }
        }
        // Housekeeping: expired sessions and old events, once per pass.
        await this.ds.pruneExpiredSessions(nowMs());
    }

    /** Last N lines of a room's log, oldest first. */
    readLog(roomId, { lines = 200 } = {}) {
        const text = readTail(this.logPathFor(roomId));
        if (!text) return { text: '', truncated: false };
        const all = text.split(/\r?\n/);
        const wanted = Math.max(1, Math.min(2000, lines));
        const slice = all.slice(-wanted);
        return { text: slice.join('\n'), truncated: all.length > wanted };
    }

    /** Drop logs older than the retention window. Returns the removed paths. */
    pruneLogs() {
        const removed = [];
        const cutoff = nowMs() - this.config.gateways.logRetentionDays * 86_400_000;
        let entries = [];
        try {
            entries = readdirSync(this.runtimeDir);
        } catch {
            return removed;
        }
        for (const name of entries) {
            if (!/^room-\d+\.log(\.\d+)?$/.test(name)) continue;
            const full = join(this.runtimeDir, name);
            try {
                if (statSync(full).mtimeMs < cutoff) {
                    unlinkSync(full);
                    removed.push(full);
                }
            } catch { /* raced with rotation */ }
        }
        return removed;
    }

    #rotateLog(logPath) {
        try {
            if (!existsSync(logPath)) return;
            if (statSync(logPath).size < MAX_LOG_BYTES) return;
            for (let index = LOG_KEEP - 1; index >= 1; index -= 1) {
                const from = `${logPath}.${index}`;
                const to = `${logPath}.${index + 1}`;
                if (existsSync(from)) {
                    if (index + 1 > LOG_KEEP) {
                        unlinkSync(from);
                    } else {
                        renameSync(from, to);
                    }
                }
            }
            renameSync(logPath, `${logPath}.1`);
        } catch (error) {
            this.logger.warn('log rotation failed', { logPath, error: error.message });
        }
    }
}

export { readTail, MAX_LOG_BYTES };
