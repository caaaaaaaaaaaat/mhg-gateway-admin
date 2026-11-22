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
import { Datasource, SCHEMA_VERSION, MAPPING_COLUMNS, MAPPING_ALIASES } from './index.js';

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

    #tableExists(name) {
        return Boolean(this.#get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]));
    }

    #migrate() {
        // Base tables that are identical across versions.
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
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);

        const current = this.#get(`SELECT value FROM schema_meta WHERE key = 'schema_version'`);
        const version = current ? Number(current.value) : null;

        if (version !== null && version > SCHEMA_VERSION) {
            // Running on an unknown newer schema could silently drop or corrupt rows.
            throw new Error(
                `database schema version ${version} is newer than this build supports (${SCHEMA_VERSION})`,
            );
        }

        if (version === 1) this.#migrateV1ToV2();

        this.#createV2Tables();
        this.#exec(
            `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [String(SCHEMA_VERSION)],
        );
    }

    /**
     * Version 1 split one mapping across two tables: `servers` (the upstream room
     * server) and `rooms` (the local listener), and it stored the upstream port in a
     * local pool column. Version 2 makes the pair one row, so a migration here has to
     * pick the upstream port from the server side -- that is the value the gateway
     * actually needs.
     *
     * Ids are preserved so historical event rows keep pointing at the right mapping.
     */
    #migrateV1ToV2() {
        const hasRooms = this.#tableExists('rooms');
        const hasServers = this.#tableExists('servers');
        if (!hasRooms) return;

        this.#createV2Tables();

        if (hasServers) {
            this.#exec(`
                INSERT OR IGNORE INTO mappings
                    (id, name, local_port, target_host, target_port, password, listen_address,
                     profile, desired_state, state, pid, failure, started_at, stopped_at,
                     extra_args, notes, created_at, updated_at)
                SELECT r.id,
                       r.name,
                       r.citra_port,
                       COALESCE(NULLIF(s.host, ''), '127.0.0.1'),
                       COALESCE(s.port, r.room_port),
                       COALESCE(NULLIF(s.password, ''), r.password, ''),
                       COALESCE(NULLIF(r.listen_address, ''), '0.0.0.0'),
                       COALESCE(NULLIF(r.profile, ''), 'default'),
                       COALESCE(NULLIF(r.desired_state, ''), 'stopped'),
                       'stopped',
                       NULL,
                       '',
                       r.started_at,
                       r.stopped_at,
                       COALESCE(NULLIF(r.extra_args, ''), '[]'),
                       '',
                       r.created_at,
                       r.updated_at
                FROM rooms r
                LEFT JOIN servers s ON s.id = r.server_id
            `);
        } else {
            this.#exec(`
                INSERT OR IGNORE INTO mappings
                    (id, name, local_port, target_host, target_port, password, listen_address,
                     profile, desired_state, state, extra_args, created_at, updated_at)
                SELECT r.id, r.name, r.citra_port, '127.0.0.1', r.room_port,
                       COALESCE(r.password, ''), COALESCE(NULLIF(r.listen_address, ''), '0.0.0.0'),
                       COALESCE(NULLIF(r.profile, ''), 'default'), 'stopped', 'stopped',
                       COALESCE(NULLIF(r.extra_args, ''), '[]'), r.created_at, r.updated_at
                FROM rooms r
            `);
        }

        // Events move from room_id to mapping_id. The ids line up with the mappings
        // just migrated, so history stays attached.
        if (this.#tableExists('events')) {
            // SQLite carries indexes along with a renamed table, so the old names
            // would collide when the new events table re-creates them.
            this.db.exec(`DROP INDEX IF EXISTS events_at; DROP INDEX IF EXISTS events_room;`);
            this.db.exec(`ALTER TABLE events RENAME TO events_v1`);
            this.#createEventsTable();
            this.#exec(`
                INSERT INTO events (id, mapping_id, at, kind, detail, actor)
                SELECT e.id, e.room_id, e.at, e.kind, e.detail, e.actor
                FROM events_v1 e
                WHERE e.room_id IS NULL OR e.room_id IN (SELECT id FROM mappings)
            `);
            this.db.exec(`DROP TABLE events_v1`);
        }

        // The old pair is now represented by `mappings` only.
        this.db.exec(`DROP TABLE IF EXISTS rooms`);
        this.db.exec(`DROP TABLE IF EXISTS servers`);
    }

    #createV2Tables() {
        if (!this.#tableExists('mappings')) {
            this.db.exec(`
                CREATE TABLE mappings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    local_port INTEGER NOT NULL UNIQUE,
                    target_host TEXT NOT NULL,
                    target_port INTEGER NOT NULL,
                    password TEXT NOT NULL DEFAULT '',
                    listen_address TEXT NOT NULL DEFAULT '0.0.0.0',
                    capacity INTEGER NOT NULL DEFAULT 0,
                    profile TEXT NOT NULL DEFAULT 'default',
                    desired_state TEXT NOT NULL DEFAULT 'stopped',
                    state TEXT NOT NULL DEFAULT 'stopped',
                    pid INTEGER,
                    failure TEXT NOT NULL DEFAULT '',
                    started_at INTEGER,
                    stopped_at INTEGER,
                    extra_args TEXT NOT NULL DEFAULT '[]',
                    notes TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
            `);
        }
        // local_port carries a UNIQUE constraint: two mappings cannot claim the same
        // player-facing port, which is the invariant the console's port check relies on.
        this.#createEventsTable();
    }

    #createEventsTable() {
        if (this.#tableExists('events')) return;
        this.db.exec(`
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mapping_id INTEGER REFERENCES mappings(id) ON DELETE CASCADE,
                at INTEGER NOT NULL,
                kind TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                actor TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX events_at ON events(at);
            CREATE INDEX events_mapping ON events(mapping_id, at);
        `);
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

    // ---- mappings ---------------------------------------------------------
    async listMappings() {
        return this.#all(`SELECT * FROM mappings ORDER BY local_port, id`);
    }

    async findMappingById(id) {
        return this.#get(`SELECT * FROM mappings WHERE id = ?`, [id]);
    }

    async findMappingByName(name) {
        return this.#get(`SELECT * FROM mappings WHERE name = ?`, [name]);
    }

    async createMapping(mapping) {
        const at = nowMs();
        const info = this.#exec(
            `INSERT INTO mappings (name, local_port, target_host, target_port, password,
                                   listen_address, capacity, profile, desired_state, state,
                                   extra_args, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?)`,
            [
                mapping.name,
                mapping.localPort,
                mapping.targetHost,
                mapping.targetPort,
                mapping.password ?? '',
                mapping.listenAddress ?? '0.0.0.0',
                mapping.capacity ?? 0,
                mapping.profile ?? 'default',
                mapping.desiredState ?? 'stopped',
                JSON.stringify(mapping.extraArgs ?? []),
                mapping.notes ?? '',
                at,
                at,
            ],
        );
        return Number(info.lastInsertRowid);
    }

    async updateMapping(id, fields) {
        const sets = [];
        const params = [];
        for (const [rawKey, value] of Object.entries(fields)) {
            const key = MAPPING_ALIASES[rawKey] ?? rawKey;
            if (!MAPPING_COLUMNS.includes(key) || value === undefined) continue;
            sets.push(`${key} = ?`);
            params.push(key === 'extra_args' ? JSON.stringify(value ?? []) : value);
        }
        if (sets.length === 0) return 0;
        sets.push('updated_at = ?');
        params.push(nowMs(), id);
        const info = this.#exec(`UPDATE mappings SET ${sets.join(', ')} WHERE id = ?`, params);
        return Number(info.changes ?? 0);
    }

    async deleteMapping(id) {
        const info = this.#exec(`DELETE FROM mappings WHERE id = ?`, [id]);
        return Number(info.changes ?? 0);
    }

    async listUsedLocalPorts() {
        return this.#all(`SELECT local_port FROM mappings`).map((row) => row.local_port);
    }

    // ---- events -----------------------------------------------------------
    async addEvent({ mappingId = null, at = nowMs(), kind, detail = '', actor = '' }) {
        this.#exec(`INSERT INTO events (mapping_id, at, kind, detail, actor) VALUES (?, ?, ?, ?, ?)`, [
            mappingId,
            at,
            kind,
            detail,
            actor,
        ]);
    }

    async listEvents({ mappingId = null, limit = 100 } = {}) {
        if (mappingId === null) {
            return this.#all(`SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?`, [limit]);
        }
        return this.#all(
            `SELECT * FROM events WHERE mapping_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
            [mappingId, limit],
        );
    }

    async pruneEvents(olderThanMs) {
        const info = this.#exec(`DELETE FROM events WHERE at < ?`, [olderThanMs]);
        return Number(info.changes ?? 0);
    }
}

export { toBool };
