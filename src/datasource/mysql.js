// SPDX-License-Identifier: GPL-3.0-or-later
// MySQL driver (optional dependency: mysql2).
//
// Same Datasource contract as SQLite. The point of shipping two drivers is that
// the console is a *batch* manager: several operators or several sites may want
// one shared database, which SQLite cannot offer over a network.
//
// mysql2 is declared in optionalDependencies so a SQLite-only deployment never
// installs or builds it. Requiring the driver without the package produces a
// message that names the exact install command.

import { Datasource, SCHEMA_VERSION } from './index.js';

function nowMs() {
    return Date.now();
}

function ident(name) {
    return '`' + String(name).replace(/`/g, '``') + '`';
}

export class MysqlDatasource extends Datasource {
    constructor(options) {
        super();
        this.options = options;
        this.pool = null;
    }

    get driver() {
        return 'mysql';
    }

    async init() {
        let mysql;
        try {
            mysql = await import('mysql2/promise');
        } catch (error) {
            const hint = 'mysql2 未安装。使用 MySQL 数据源前请执行: npm install mysql2';
            const wrapped = new Error(`${hint} (${error.code ?? error.message})`);
            wrapped.code = 'MYSQL2_MISSING';
            throw wrapped;
        }
        const createPool = mysql.createPool ?? mysql.default?.createPool;
        if (typeof createPool !== 'function') {
            throw new Error('mysql2 loaded but createPool is unavailable');
        }
        this.pool = createPool({
            host: this.options.host,
            port: this.options.port,
            user: this.options.user,
            password: this.options.password,
            database: this.options.database,
            waitForConnections: true,
            connectionLimit: this.options.connectionLimit,
            charset: 'utf8mb4',
            timezone: 'Z',
            supportBigNumbers: true,
            ssl: this.options.ssl ? {} : undefined,
        });
        await this.#migrate();
        return this;
    }

    async close() {
        if (this.pool) {
            try {
                await this.pool.end();
            } finally {
                this.pool = null;
            }
        }
    }

    async ping() {
        if (!this.pool) throw new Error('database is not open');
        await this.pool.query('SELECT 1');
    }

    get prefix() {
        return this.options.tablePrefix ?? '';
    }

    table(name) {
        return ident(this.prefix + name);
    }

    async #exec(sql, params = []) {
        if (!this.pool) throw new Error('database is not open');
        const [result] = await this.pool.execute(sql, params);
        return result;
    }

    async #get(sql, params = []) {
        if (!this.pool) throw new Error('database is not open');
        const [rows] = await this.pool.execute(sql, params);
        return rows[0] ?? undefined;
    }

    async #all(sql, params = []) {
        if (!this.pool) throw new Error('database is not open');
        const [rows] = await this.pool.execute(sql, params);
        return rows;
    }

    async #migrate() {
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('schema_meta')} (
                \`key\` VARCHAR(64) NOT NULL PRIMARY KEY,
                \`value\` VARCHAR(255) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('users')} (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(64) NOT NULL,
                password_hash VARCHAR(512) NOT NULL,
                role VARCHAR(16) NOT NULL DEFAULT 'admin',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                last_login_at BIGINT NULL,
                failed_logins INT NOT NULL DEFAULT 0,
                locked_until BIGINT NULL,
                disabled TINYINT NOT NULL DEFAULT 0,
                UNIQUE KEY uniq_users_username (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('sessions')} (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                token_hash CHAR(64) NOT NULL,
                user_id BIGINT NOT NULL,
                csrf_token VARCHAR(96) NOT NULL,
                created_at BIGINT NOT NULL,
                last_seen_at BIGINT NOT NULL,
                expires_at BIGINT NOT NULL,
                user_agent VARCHAR(255) NOT NULL DEFAULT '',
                remote_addr VARCHAR(64) NOT NULL DEFAULT '',
                UNIQUE KEY uniq_sessions_token (token_hash),
                KEY idx_sessions_user (user_id),
                KEY idx_sessions_expiry (expires_at),
                CONSTRAINT fk_sessions_user FOREIGN KEY (user_id)
                    REFERENCES ${this.table('users')} (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('servers')} (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(64) NOT NULL,
                host VARCHAR(255) NOT NULL,
                port INT NOT NULL,
                password VARCHAR(255) NOT NULL DEFAULT '',
                notes VARCHAR(1024) NOT NULL DEFAULT '',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE KEY uniq_servers_name (name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('rooms')} (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(64) NOT NULL,
                server_id BIGINT NULL,
                citra_port INT NOT NULL,
                room_port INT NOT NULL,
                listen_address VARCHAR(64) NOT NULL DEFAULT '0.0.0.0',
                password VARCHAR(255) NOT NULL DEFAULT '',
                profile VARCHAR(32) NOT NULL DEFAULT 'default',
                desired_state VARCHAR(16) NOT NULL DEFAULT 'stopped',
                state VARCHAR(16) NOT NULL DEFAULT 'stopped',
                pid INT NULL,
                failure VARCHAR(512) NOT NULL DEFAULT '',
                started_at BIGINT NULL,
                stopped_at BIGINT NULL,
                extra_args TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE KEY uniq_rooms_name (name),
                KEY idx_rooms_server (server_id),
                CONSTRAINT fk_rooms_server FOREIGN KEY (server_id)
                    REFERENCES ${this.table('servers')} (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('events')} (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                room_id BIGINT NULL,
                at BIGINT NOT NULL,
                kind VARCHAR(64) NOT NULL,
                detail VARCHAR(1024) NOT NULL DEFAULT '',
                actor VARCHAR(64) NOT NULL DEFAULT '',
                KEY idx_events_at (at),
                KEY idx_events_room (room_id, at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('settings')} (
                \`key\` VARCHAR(128) NOT NULL PRIMARY KEY,
                \`value\` TEXT NOT NULL,
                updated_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        const current = await this.#get(
            `SELECT \`value\` AS v FROM ${this.table('schema_meta')} WHERE \`key\` = 'schema_version'`,
        );
        if (!current) {
            await this.#exec(
                `INSERT INTO ${this.table('schema_meta')} (\`key\`, \`value\`) VALUES ('schema_version', ?)`,
                [String(SCHEMA_VERSION)],
            );
        } else if (Number(current.v) !== SCHEMA_VERSION) {
            throw new Error(
                `database schema version ${current.v} is not supported by this build (expected ${SCHEMA_VERSION})`,
            );
        }
    }

    // ---- settings ---------------------------------------------------------
    async getSetting(key) {
        const row = await this.#get(
            `SELECT \`value\` AS v FROM ${this.table('settings')} WHERE \`key\` = ?`,
            [key],
        );
        return row ? row.v : null;
    }

    async setSetting(key, value) {
        await this.#exec(
            `INSERT INTO ${this.table('settings')} (\`key\`, \`value\`, updated_at) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = VALUES(updated_at)`,
            [key, value, nowMs()],
        );
    }

    // ---- users ------------------------------------------------------------
    async countUsers() {
        const row = await this.#get(`SELECT COUNT(*) AS n FROM ${this.table('users')}`);
        return Number(row.n);
    }

    async createUser({ username, passwordHash, role = 'admin' }) {
        const at = nowMs();
        const result = await this.#exec(
            `INSERT INTO ${this.table('users')} (username, password_hash, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            [username, passwordHash, role, at, at],
        );
        return Number(result.insertId);
    }

    async findUserByUsername(username) {
        return this.#get(`SELECT * FROM ${this.table('users')} WHERE username = ?`, [username]);
    }

    async findUserById(id) {
        return this.#get(`SELECT * FROM ${this.table('users')} WHERE id = ?`, [id]);
    }

    async listUsers() {
        return this.#all(
            `SELECT id, username, role, created_at, updated_at, last_login_at,
                    failed_logins, locked_until, disabled
             FROM ${this.table('users')} ORDER BY id`,
        );
    }

    async updateUserPassword(id, passwordHash) {
        await this.#exec(
            `UPDATE ${this.table('users')} SET password_hash = ?, updated_at = ? WHERE id = ?`,
            [passwordHash, nowMs(), id],
        );
    }

    async recordLoginSuccess(id, at) {
        await this.#exec(
            `UPDATE ${this.table('users')} SET last_login_at = ?, failed_logins = 0,
                    locked_until = NULL, updated_at = ? WHERE id = ?`,
            [at, at, id],
        );
    }

    async recordLoginFailure(id, { failedLogins, lockedUntil }) {
        await this.#exec(
            `UPDATE ${this.table('users')} SET failed_logins = ?, locked_until = ?, updated_at = ?
             WHERE id = ?`,
            [failedLogins, lockedUntil, nowMs(), id],
        );
    }

    async deleteUser(id) {
        await this.#exec(`DELETE FROM ${this.table('users')} WHERE id = ?`, [id]);
    }

    // ---- sessions ---------------------------------------------------------
    async createSession({ tokenHash, userId, csrfToken, expiresAt, userAgent, remoteAddr }) {
        const at = nowMs();
        const result = await this.#exec(
            `INSERT INTO ${this.table('sessions')} (token_hash, user_id, csrf_token, created_at,
                    last_seen_at, expires_at, user_agent, remote_addr)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [tokenHash, userId, csrfToken, at, at, expiresAt, userAgent ?? '', remoteAddr ?? ''],
        );
        return Number(result.insertId);
    }

    async findSessionByTokenHash(tokenHash) {
        return this.#get(`SELECT * FROM ${this.table('sessions')} WHERE token_hash = ?`, [tokenHash]);
    }

    async touchSession(id, { lastSeenAt, expiresAt }) {
        await this.#exec(
            `UPDATE ${this.table('sessions')} SET last_seen_at = ?, expires_at = ? WHERE id = ?`,
            [lastSeenAt, expiresAt, id],
        );
    }

    async deleteSession(id) {
        await this.#exec(`DELETE FROM ${this.table('sessions')} WHERE id = ?`, [id]);
    }

    async deleteSessionsForUser(userId) {
        await this.#exec(`DELETE FROM ${this.table('sessions')} WHERE user_id = ?`, [userId]);
    }

    async pruneExpiredSessions(now) {
        const result = await this.#exec(
            `DELETE FROM ${this.table('sessions')} WHERE expires_at <= ?`,
            [now],
        );
        return Number(result.affectedRows ?? 0);
    }

    // ---- servers ----------------------------------------------------------
    async listServers() {
        return this.#all(`SELECT * FROM ${this.table('servers')} ORDER BY name`);
    }

    async findServerById(id) {
        return this.#get(`SELECT * FROM ${this.table('servers')} WHERE id = ?`, [id]);
    }

    async createServer({ name, host, port, password = '', notes = '' }) {
        const at = nowMs();
        const result = await this.#exec(
            `INSERT INTO ${this.table('servers')} (name, host, port, password, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, host, port, password, notes, at, at],
        );
        return Number(result.insertId);
    }

    async updateServer(id, fields) {
        const allowed = ['name', 'host', 'port', 'password', 'notes'];
        const sets = [];
        const params = [];
        for (const key of allowed) {
            if (fields[key] !== undefined) {
                sets.push(`${ident(key)} = ?`);
                params.push(fields[key]);
            }
        }
        if (sets.length === 0) return;
        sets.push('updated_at = ?');
        params.push(nowMs(), id);
        await this.#exec(`UPDATE ${this.table('servers')} SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    async deleteServer(id) {
        await this.#exec(`DELETE FROM ${this.table('servers')} WHERE id = ?`, [id]);
    }

    // ---- rooms ------------------------------------------------------------
    async listRooms() {
        return this.#all(`SELECT * FROM ${this.table('rooms')} ORDER BY name`);
    }

    async findRoomById(id) {
        return this.#get(`SELECT * FROM ${this.table('rooms')} WHERE id = ?`, [id]);
    }

    async findRoomByName(name) {
        return this.#get(`SELECT * FROM ${this.table('rooms')} WHERE name = ?`, [name]);
    }

    async createRoom(room) {
        const at = nowMs();
        const result = await this.#exec(
            `INSERT INTO ${this.table('rooms')} (name, server_id, citra_port, room_port,
                    listen_address, password, profile, desired_state, state, extra_args,
                    created_at, updated_at)
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
        return Number(result.insertId);
    }

    async updateRoom(id, fields) {
        const allowed = [
            'name', 'server_id', 'citra_port', 'room_port', 'listen_address', 'password',
            'profile', 'desired_state', 'state', 'pid', 'failure', 'started_at', 'stopped_at',
            'extra_args',
        ];
        // Same camelCase -> column alias mapping as the SQLite driver.
        const aliases = { extraArgs: 'extra_args', citraPort: 'citra_port', roomPort: 'room_port' };
        const sets = [];
        const params = [];
        for (const [rawKey, value] of Object.entries(fields)) {
            const key = aliases[rawKey] ?? rawKey;
            if (!allowed.includes(key) || value === undefined) continue;
            sets.push(`${ident(key)} = ?`);
            params.push(key === 'extra_args' ? JSON.stringify(value) : value);
        }
        if (sets.length === 0) return;
        sets.push('updated_at = ?');
        params.push(nowMs(), id);
        await this.#exec(`UPDATE ${this.table('rooms')} SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    async deleteRoom(id) {
        await this.#exec(`DELETE FROM ${this.table('rooms')} WHERE id = ?`, [id]);
    }

    async listUsedPorts() {
        const rows = await this.#all(`SELECT citra_port, room_port FROM ${this.table('rooms')}`);
        return {
            citra: new Set(rows.map((row) => Number(row.citra_port))),
            room: new Set(rows.map((row) => Number(row.room_port))),
        };
    }

    // ---- events -----------------------------------------------------------
    async addEvent({ roomId = null, at = nowMs(), kind, detail = '', actor = '' }) {
        await this.#exec(
            `INSERT INTO ${this.table('events')} (room_id, at, kind, detail, actor) VALUES (?, ?, ?, ?, ?)`,
            [roomId, at, kind, detail, actor],
        );
    }

    async listEvents({ roomId = null, limit = 100 } = {}) {
        if (roomId === null) {
            return this.#all(
                `SELECT * FROM ${this.table('events')} ORDER BY at DESC, id DESC LIMIT ?`,
                [limit],
            );
        }
        return this.#all(
            `SELECT * FROM ${this.table('events')} WHERE room_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
            [roomId, limit],
        );
    }

    async pruneEvents(olderThanMs) {
        const result = await this.#exec(`DELETE FROM ${this.table('events')} WHERE at < ?`, [olderThanMs]);
        return Number(result.affectedRows ?? 0);
    }
}
