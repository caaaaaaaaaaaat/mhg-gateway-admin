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

import { Datasource, SCHEMA_VERSION, MAPPING_COLUMNS, MAPPING_ALIASES } from './index.js';

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
        // Mappings: one row is one pair (local port -> one upstream room server).
        // local_port is UNIQUE so two rows cannot claim the same player-facing port.
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('mappings')} (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(64) NOT NULL,
                local_port INT NOT NULL,
                target_host VARCHAR(255) NOT NULL,
                target_port INT NOT NULL,
                password VARCHAR(255) NOT NULL DEFAULT '',
                listen_address VARCHAR(64) NOT NULL DEFAULT '0.0.0.0',
                capacity INT NOT NULL DEFAULT 4,
                profile VARCHAR(32) NOT NULL DEFAULT 'default',
                desired_state VARCHAR(16) NOT NULL DEFAULT 'stopped',
                state VARCHAR(16) NOT NULL DEFAULT 'stopped',
                pid INT NULL,
                failure VARCHAR(512) NOT NULL DEFAULT '',
                started_at BIGINT NULL,
                stopped_at BIGINT NULL,
                extra_args TEXT NOT NULL,
                notes VARCHAR(1024) NOT NULL DEFAULT '',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE KEY uniq_mappings_name (name),
                UNIQUE KEY uniq_mappings_local_port (local_port)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.#exec(`
            CREATE TABLE IF NOT EXISTS ${this.table('events')} (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                mapping_id BIGINT NULL,
                at BIGINT NOT NULL,
                kind VARCHAR(64) NOT NULL,
                detail VARCHAR(1024) NOT NULL DEFAULT '',
                actor VARCHAR(64) NOT NULL DEFAULT '',
                KEY idx_events_at (at),
                KEY idx_events_mapping (mapping_id, at)
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
        const version = current ? Number(current.v) : null;
        if (version !== null && version > SCHEMA_VERSION) {
            // Running on a newer schema could silently drop or corrupt rows.
            throw new Error(
                `database schema version ${version} is newer than this build supports (${SCHEMA_VERSION})`,
            );
        }
        if (version === 1 && (await this.#tableExists('rooms'))) {
            await this.#migrateV1ToV2();
        }
        await this.#exec(
            `INSERT INTO ${this.table('schema_meta')} (\`key\`, \`value\`) VALUES ('schema_version', ?)
             ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
            [String(SCHEMA_VERSION)],
        );
    }

    /** MySQL has no sqlite_master; information_schema is the portable check. */
    async #tableExists(name) {
        const row = await this.#get(
            `SELECT COUNT(*) AS n FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = ?`,
            [this.prefix + name],
        );
        return Number(row?.n ?? 0) > 0;
    }

    /**
     * Version 1 stored one mapping across `servers` + `rooms`, and kept the upstream
     * port in a local pool column. Version 2 makes the pair one row, and the upstream
     * port has to come from the server side because that is what the gateway dials.
     * Ids are preserved so event history keeps pointing at the right mapping.
     */
    async #migrateV1ToV2() {
        const hasServers = await this.#tableExists('servers');
        if (hasServers) {
            await this.#exec(`
                INSERT IGNORE INTO ${this.table('mappings')}
                    (id, name, local_port, target_host, target_port, password, listen_address,
                     profile, desired_state, state, extra_args, notes, created_at, updated_at)
                SELECT r.id, r.name, r.citra_port,
                       COALESCE(NULLIF(s.host, ''), '127.0.0.1'),
                       COALESCE(s.port, r.room_port),
                       COALESCE(NULLIF(s.password, ''), r.password, ''),
                       COALESCE(NULLIF(r.listen_address, ''), '0.0.0.0'),
                       COALESCE(NULLIF(r.profile, ''), 'default'),
                       'stopped', 'stopped',
                       COALESCE(NULLIF(r.extra_args, ''), '[]'),
                       '', r.created_at, r.updated_at
                FROM ${this.table('rooms')} r
                LEFT JOIN ${this.table('servers')} s ON s.id = r.server_id
            `);
        } else {
            await this.#exec(`
                INSERT IGNORE INTO ${this.table('mappings')}
                    (id, name, local_port, target_host, target_port, password, listen_address,
                     profile, desired_state, state, extra_args, notes, created_at, updated_at)
                SELECT r.id, r.name, r.citra_port, '127.0.0.1', r.room_port,
                       COALESCE(r.password, ''), COALESCE(NULLIF(r.listen_address, ''), '0.0.0.0'),
                       COALESCE(NULLIF(r.profile, ''), 'default'), 'stopped', 'stopped',
                       COALESCE(NULLIF(r.extra_args, ''), '[]'), '', r.created_at, r.updated_at
                FROM ${this.table('rooms')} r
            `);
        }
        if (await this.#tableExists('events')) {
            await this.#exec(`RENAME TABLE ${this.table('events')} TO ${this.table('events_v1')}`);
            await this.#exec(`
                CREATE TABLE ${this.table('events')} (
                    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    mapping_id BIGINT NULL,
                    at BIGINT NOT NULL,
                    kind VARCHAR(64) NOT NULL,
                    detail VARCHAR(1024) NOT NULL DEFAULT '',
                    actor VARCHAR(64) NOT NULL DEFAULT '',
                    KEY idx_events_at (at),
                    KEY idx_events_mapping (mapping_id, at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            await this.#exec(`
                INSERT INTO ${this.table('events')} (id, mapping_id, at, kind, detail, actor)
                SELECT e.id, e.room_id, e.at, e.kind, e.detail, e.actor
                FROM ${this.table('events_v1')} e
                WHERE e.room_id IS NULL OR e.room_id IN (SELECT id FROM ${this.table('mappings')})
            `);
            await this.#exec(`DROP TABLE ${this.table('events_v1')}`);
        }
        await this.#exec(`DROP TABLE IF EXISTS ${this.table('rooms')}`);
        await this.#exec(`DROP TABLE IF EXISTS ${this.table('servers')}`);
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

    // ---- mappings ---------------------------------------------------------
    async listMappings() {
        return this.#all(`SELECT * FROM ${this.table('mappings')} ORDER BY local_port, id`);
    }

    async findMappingById(id) {
        return this.#get(`SELECT * FROM ${this.table('mappings')} WHERE id = ?`, [id]);
    }

    async findMappingByName(name) {
        return this.#get(`SELECT * FROM ${this.table('mappings')} WHERE name = ?`, [name]);
    }

    async createMapping(mapping) {
        const at = nowMs();
        const result = await this.#exec(
            `INSERT INTO ${this.table('mappings')} (name, local_port, target_host, target_port,
                    password, listen_address, capacity, profile, desired_state, state,
                    extra_args, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?)`,
            [
                mapping.name,
                mapping.localPort,
                mapping.targetHost,
                mapping.targetPort,
                mapping.password ?? '',
                mapping.listenAddress ?? '0.0.0.0',
                mapping.capacity ?? 4,
                mapping.profile ?? 'default',
                mapping.desiredState ?? 'stopped',
                JSON.stringify(mapping.extraArgs ?? []),
                mapping.notes ?? '',
                at,
                at,
            ],
        );
        return Number(result.insertId);
    }

    async updateMapping(id, fields) {
        const sets = [];
        const params = [];
        for (const [rawKey, value] of Object.entries(fields)) {
            const key = MAPPING_ALIASES[rawKey] ?? rawKey;
            if (!MAPPING_COLUMNS.includes(key) || value === undefined) continue;
            sets.push(`${ident(key)} = ?`);
            params.push(key === 'extra_args' ? JSON.stringify(value ?? []) : value);
        }
        if (sets.length === 0) return 0;
        sets.push('updated_at = ?');
        params.push(nowMs(), id);
        const result = await this.#exec(
            `UPDATE ${this.table('mappings')} SET ${sets.join(', ')} WHERE id = ?`,
            params,
        );
        return Number(result.affectedRows ?? 0);
    }

    async deleteMapping(id) {
        const result = await this.#exec(`DELETE FROM ${this.table('mappings')} WHERE id = ?`, [id]);
        return Number(result.affectedRows ?? 0);
    }

    async listUsedLocalPorts() {
        const rows = await this.#all(`SELECT local_port FROM ${this.table('mappings')}`);
        return rows.map((row) => Number(row.local_port));
    }

    // ---- events -----------------------------------------------------------
    async addEvent({ mappingId = null, at = nowMs(), kind, detail = '', actor = '' }) {
        await this.#exec(
            `INSERT INTO ${this.table('events')} (mapping_id, at, kind, detail, actor)
             VALUES (?, ?, ?, ?, ?)`,
            [mappingId, at, kind, detail, actor],
        );
    }

    async listEvents({ mappingId = null, limit = 100 } = {}) {
        if (mappingId === null) {
            return this.#all(
                `SELECT * FROM ${this.table('events')} ORDER BY at DESC, id DESC LIMIT ?`,
                [limit],
            );
        }
        return this.#all(
            `SELECT * FROM ${this.table('events')} WHERE mapping_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
            [mappingId, limit],
        );
    }

    async pruneEvents(olderThanMs) {
        const result = await this.#exec(`DELETE FROM ${this.table('events')} WHERE at < ?`, [olderThanMs]);
        return Number(result.affectedRows ?? 0);
    }
}
