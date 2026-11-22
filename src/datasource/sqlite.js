// SPDX-License-Identifier: GPL-3.0-or-later
// SQLite driver built on node:sqlite (built into Node.js; no native build).
//
// node:sqlite is still flagged experimental in Node 22/24, so this module:
//   * tolerates the ExperimentalWarning on stderr (it is not an error), and
//   * reports a clear, actionable error when the API is missing or older than
//     the version whose behaviour this driver is written against.
//
// Synchronous calls are wrapped in async methods so the driver matches the
// Datasource contract exactly like a network-backed one.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Datasource, SCHEMA_VERSION } from './index.js';

const SQLITE_TIMEOUT_MS = 5000;

function nowMs() {
    return Date.now();
}

function toBool(value) {
    return value === 1 || value === true ? 1 : 0;
}

export class SqliteDatasource extends Datasource {
    constructor({ path }) {
        super();
        this.path = path;
        this.db = null;
    }

    get driver() {
        return 'sqlite';
    }

    async init() {
        // Repeated init() is a supported no-op migration path (a caller may re-run
        // startup after a failed request), but it must not leak the previous handle.
        if (this.db) await this.close();
        // `:memory:` (and the URI form `file::memory:`) are not filesystem paths:
        // creating a directory for them would either fail or create a literal
        // directory named ':memory:'.
        const isMemory = this.path === ':memory:' || this.path.startsWith('file::memory:');
        if (!isMemory) mkdirSync(dirname(this.path), { recursive: true });
        this.db = new DatabaseSync(this.path);
        this.db.exec(`PRAGMA journal_mode = WAL;`);
        this.db.exec(`PRAGMA foreign_keys = ON;`);
        this.db.exec(`PRAGMA busy_timeout = ${SQLITE_TIMEOUT_MS};`);
        this.db.exec(`PRAGMA synchronous = NORMAL;`);
        this.#migrate();
        return this;
    }

    async close() {
        if (this.db) {
            try {
                this.db.close();
            } finally {
                this.db = null;
            }
        }
    }

    async ping() {
        if (!this.db) throw new Error('database is not open');
        this.db.prepare('SELECT 1 AS ok').get();
    }

    #exec(sql, params = []) {
        if (!this.db) throw new Error('database is not open');
        return this.db.prepare(sql).run(...params);
    }

    #get(sql, params = []) {
        if (!this.db) throw new Error('database is not open');
        return this.db.prepare(sql).get(...params) ?? undefined;
    }

    #all(sql, params = []) {
        if (!this.db) throw new Error('database is not open');
        return this.db.prepare(sql).all(...params);
    }

    #migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_login_at INTEGER,
                failed_logins INTEGER NOT NULL DEFAULT 0,
                locked_until INTEGER,
                disabled INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT NOT NULL UNIQUE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                csrf_token TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                user_agent TEXT NOT NULL DEFAULT '',
                remote_addr TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
            CREATE TABLE IF NOT EXISTS servers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                password TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
                citra_port INTEGER NOT NULL,
                room_port INTEGER NOT NULL,
                listen_address TEXT NOT NULL DEFAULT '0.0.0.0',
                password TEXT NOT NULL DEFAULT '',
                profile TEXT NOT NULL DEFAULT 'default',
                desired_state TEXT NOT NULL DEFAULT 'stopped',
                state TEXT NOT NULL DEFAULT 'stopped',
                pid INTEGER,
                failure TEXT NOT NULL DEFAULT '',
                started_at INTEGER,
                stopped_at INTEGER,
                extra_args TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
                at INTEGER NOT NULL,
                kind TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                actor TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS events_at ON events(at);
            CREATE INDEX IF NOT EXISTS events_room ON events(room_id, at);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
        const current = this.#get(`SELECT value FROM schema_meta WHERE key = 'schema_version'`);
        if (!current) {
            this.#exec(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)`, [
                String(SCHEMA_VERSION),
            ]);
        } else if (Number(current.value) !== SCHEMA_VERSION) {
            // Only v1 exists so far; a future migration adds its step here and
            // updates schema_meta. Failing loudly beats running on an unknown
            // schema and silently losing rows.
            throw new Error(
                `database schema version ${current.value} is not supported by this build (expected ${SCHEMA_VERSION})`,
            );
        }
    }

    // ---- settings ---------------------------------------------------------
    async getSetting(key) {
        const row = this.#get(`SELECT value FROM settings WHERE key = ?`, [key]);
        return row ? row.value : null;
    }

    async setSetting(key, value) {
        this.#exec(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, value, nowMs()],
        );
    }

    // ---- users ------------------------------------------------------------
    async countUsers() {
        return this.#get(`SELECT COUNT(*) AS n FROM users`).n;
    }

    async createUser({ username, passwordHash, role = 'admin' }) {
        const at = nowMs();
        const info = this.#exec(
            `INSERT INTO users (username, password_hash, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            [username, passwordHash, role, at, at],
        );
        return Number(info.lastInsertRowid);
    }

    async findUserByUsername(username) {
        return this.#get(`SELECT * FROM users WHERE username = ?`, [username]);
    }

    async findUserById(id) {
        return this.#get(`SELECT * FROM users WHERE id = ?`, [id]);
    }

    async listUsers() {
        return this.#all(
            `SELECT id, username, role, created_at, updated_at, last_login_at,
                    failed_logins, locked_until, disabled
             FROM users ORDER BY id`,
        );
    }

    async updateUserPassword(id, passwordHash) {
        this.#exec(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [
            passwordHash,
            nowMs(),
            id,
        ]);
    }

    async recordLoginSuccess(id, at) {
        this.#exec(
            `UPDATE users SET last_login_at = ?, failed_logins = 0, locked_until = NULL,
                    updated_at = ? WHERE id = ?`,
            [at, at, id],
        );
    }

    async recordLoginFailure(id, { failedLogins, lockedUntil }) {
        this.#exec(`UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?`, [
            failedLogins,
            lockedUntil,
            nowMs(),
            id,
        ]);
    }

    async deleteUser(id) {
        this.#exec(`DELETE FROM users WHERE id = ?`, [id]);
    }

    // ---- sessions ---------------------------------------------------------
    async createSession({ tokenHash, userId, csrfToken, expiresAt, userAgent, remoteAddr }) {
        const at = nowMs();
        const info = this.#exec(
            `INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at,
                                   expires_at, user_agent, remote_addr)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [tokenHash, userId, csrfToken, at, at, expiresAt, userAgent ?? '', remoteAddr ?? ''],
        );
        return Number(info.lastInsertRowid);
    }

    async findSessionByTokenHash(tokenHash) {
        return this.#get(`SELECT * FROM sessions WHERE token_hash = ?`, [tokenHash]);
    }

    async touchSession(id, { lastSeenAt, expiresAt }) {
        this.#exec(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`, [
            lastSeenAt,
            expiresAt,
            id,
        ]);
    }

    async deleteSession(id) {
        this.#exec(`DELETE FROM sessions WHERE id = ?`, [id]);
    }

    async deleteSessionsForUser(userId) {
        this.#exec(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
    }

    async pruneExpiredSessions(now) {
        const info = this.#exec(`DELETE FROM sessions WHERE expires_at <= ?`, [now]);
        return Number(info.changes ?? 0);
    }

    // ---- servers ----------------------------------------------------------
    async listServers() {
        return this.#all(`SELECT * FROM servers ORDER BY name COLLATE NOCASE`);
    }

    async findServerById(id) {
        return this.#get(`SELECT * FROM servers WHERE id = ?`, [id]);
    }

    async createServer({ name, host, port, password = '', notes = '' }) {
        const at = nowMs();
        const info = this.#exec(
            `INSERT INTO servers (name, host, port, password, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, host, port, password, notes, at, at],
        );
        return Number(info.lastInsertRowid);
    }

    async updateServer(id, fields) {
        const allowed = ['name', 'host', 'port', 'password', 'notes'];
        const sets = [];
        const params = [];
        for (const key of allowed) {
            if (fields[key] !== undefined) {
                sets.push(`${key} = ?`);
                params.push(fields[key]);
            }
        }
        if (sets.length === 0) return;
        sets.push('updated_at = ?');
        params.push(nowMs(), id);
        this.#exec(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    async deleteServer(id) {
        this.#exec(`DELETE FROM servers WHERE id = ?`, [id]);
    }

    // ---- rooms ------------------------------------------------------------
    async listRooms() {
        return this.#all(`SELECT * FROM rooms ORDER BY name COLLATE NOCASE`);
    }

    async findRoomById(id) {
        return this.#get(`SELECT * FROM rooms WHERE id = ?`, [id]);
    }

    async findRoomByName(name) {
        return this.#get(`SELECT * FROM rooms WHERE name = ?`, [name]);
    }

    async createRoom(room) {
        const at = nowMs();
        const info = this.#exec(
            `INSERT INTO rooms (name, server_id, citra_port, room_port, listen_address, password,
                                profile, desired_state, state, extra_args, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                room.name,
                room.serverId ?? null,
                room.citraPort,
                room.roomPort,
                room.listenAddress ?? '0.0.0.0',
                room.password ?? '',
                room.profile ?? 'default',
                room.desiredState ?? 'stopped',
                'stopped',
                JSON.stringify(room.extraArgs ?? []),
                at,
                at,
            ],
        );
        return Number(info.lastInsertRowid);
    }

    async updateRoom(id, fields) {
        const allowed = [
            'name', 'server_id', 'citra_port', 'room_port', 'listen_address', 'password',
            'profile', 'desired_state', 'state', 'pid', 'failure', 'started_at', 'stopped_at',
            'extra_args',
        ];
        // Callers use the camelCase field the room object exposes; the columns are
        // snake_case. Mapping here keeps the route layer free of column names.
        const aliases = { extraArgs: 'extra_args', citraPort: 'citra_port', roomPort: 'room_port' };
        const sets = [];
        const params = [];
        for (const [rawKey, value] of Object.entries(fields)) {
            const key = aliases[rawKey] ?? rawKey;
            if (!allowed.includes(key) || value === undefined) continue;
            sets.push(`${key} = ?`);
            params.push(key === 'extra_args' ? JSON.stringify(value) : value);
        }
        if (sets.length === 0) return;
        sets.push('updated_at = ?');
        params.push(nowMs(), id);
        this.#exec(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    async deleteRoom(id) {
        this.#exec(`DELETE FROM rooms WHERE id = ?`, [id]);
    }

    async listUsedPorts() {
        const rows = this.#all(`SELECT citra_port, room_port FROM rooms`);
        return {
            citra: new Set(rows.map((row) => row.citra_port)),
            room: new Set(rows.map((row) => row.room_port)),
        };
    }

    // ---- events -----------------------------------------------------------
    async addEvent({ roomId = null, at = nowMs(), kind, detail = '', actor = '' }) {
        this.#exec(`INSERT INTO events (room_id, at, kind, detail, actor) VALUES (?, ?, ?, ?, ?)`, [
            roomId,
            at,
            kind,
            detail,
            actor,
        ]);
    }

    async listEvents({ roomId = null, limit = 100 } = {}) {
        if (roomId === null) {
            return this.#all(`SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?`, [limit]);
        }
        return this.#all(
            `SELECT * FROM events WHERE room_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
            [roomId, limit],
        );
    }

    async pruneEvents(olderThanMs) {
        const info = this.#exec(`DELETE FROM events WHERE at < ?`, [olderThanMs]);
        return Number(info.changes ?? 0);
    }
}

export { toBool };
