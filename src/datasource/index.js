// SPDX-License-Identifier: GPL-3.0-or-later
// Datasource contract.
//
// The whole console talks to this interface and nothing else. A driver supplies
// exactly these methods; the shape of the rows is documented per method so an
// out-of-tree driver (Postgres, a REST backend, ...) can be implemented without
// reading the routes.
//
// Conventions that every driver must honour:
//   * Timestamps are integer milliseconds since the Unix epoch (UTC).
//   * Booleans are stored as 0/1 integers.
//   * Nullable text is '' rather than NULL where the schema declares NOT NULL
//     DEFAULT ''; genuinely optional values use NULL.
//   * Methods are async even when the implementation is synchronous, so a
//     network-backed driver is a drop-in replacement.

export const SCHEMA_VERSION = 1;

/**
 * Users: the console's administrators.
 *   id            integer primary key
 *   username      unique text
 *   password_hash scrypt string (see lib/password.js)
 *   role          'owner' | 'admin' | 'viewer'
 *   created_at    integer ms
 *   updated_at    integer ms
 *   last_login_at integer ms | null
 *   failed_logins integer
 *   locked_until  integer ms | null
 *   disabled      integer 0/1
 */
export const USERS_TABLE = 'users';

/**
 * Sessions: one row per signed-in browser.
 *   id          integer primary key
 *   token_hash  text unique (sha256 of the opaque cookie value)
 *   user_id     integer -> users.id
 *   csrf_token  text
 *   created_at  integer ms
 *   last_seen_at integer ms
 *   expires_at  integer ms
 *   user_agent  text
 *   remote_addr text
 */
export const SESSIONS_TABLE = 'sessions';

/**
 * Servers: the upstream Yuzu/LDN room servers a gateway can join.
 *   id          integer primary key
 *   name        text unique friendly label
 *   host        text IPv4 literal or hostname
 *   port        integer 1..65535
 *   password    text room password (empty means none)
 *   notes       text
 *   created_at / updated_at integer ms
 */
export const SERVERS_TABLE = 'servers';

/**
 * Rooms: one managed gateway process per row.
 *   id             integer primary key
 *   name           text unique
 *   server_id      integer -> servers.id
 *   citra_port     integer
 *   room_port      integer
 *   listen_address text
 *   password       text Citra-side room password
 *   profile        text 'default' | 'dual-host' | 'legacy'
 *   desired_state  text 'running' | 'stopped'
 *   state          text 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
 *   pid            integer | null
 *   failure        text
 *   started_at     integer ms | null
 *   stopped_at     integer ms | null
 *   extra_args     text JSON array
 *   created_at / updated_at integer ms
 */
export const ROOMS_TABLE = 'rooms';

/**
 * Room events: an append-only audit trail per room and for the console itself.
 *   id         integer primary key
 *   room_id    integer | null
 *   at         integer ms
 *   kind       text
 *   detail     text
 *   actor      text
 */
export const EVENTS_TABLE = 'events';

/**
 * Settings: small key/value store for console state that must survive restarts
 * (e.g. 'setup.completed').
 *   key        text primary key
 *   value      text
 *   updated_at integer ms
 */
export const SETTINGS_TABLE = 'settings';

/**
 * The methods a driver must implement. `table` names above are what the SQL
 * drivers create; a non-SQL driver maps them onto its own storage.
 */
export class Datasource {
    /** @returns {Promise<string>} driver id, e.g. 'sqlite' */
    get driver() { throw new Error('not implemented'); }

    /** Open the connection and create/migrate the schema. */
    async init() { throw new Error('not implemented'); }

    /** Release every resource. Safe to call twice. */
    async close() { throw new Error('not implemented'); }

    /** Liveness probe used by /healthz. Throws when the store is unusable. */
    async ping() { throw new Error('not implemented'); }

    // ---- settings ---------------------------------------------------------
    async getSetting(key) { throw new Error('not implemented'); }
    async setSetting(key, value) { throw new Error('not implemented'); }

    // ---- users ------------------------------------------------------------
    async countUsers() { throw new Error('not implemented'); }
    async createUser({ username, passwordHash, role }) { throw new Error('not implemented'); }
    async findUserByUsername(username) { throw new Error('not implemented'); }
    async findUserById(id) { throw new Error('not implemented'); }
    async listUsers() { throw new Error('not implemented'); }
    async updateUserPassword(id, passwordHash) { throw new Error('not implemented'); }
    async recordLoginSuccess(id, at) { throw new Error('not implemented'); }
    async recordLoginFailure(id, { failedLogins, lockedUntil }) { throw new Error('not implemented'); }
    async deleteUser(id) { throw new Error('not implemented'); }

    // ---- sessions ---------------------------------------------------------
    async createSession({ tokenHash, userId, csrfToken, expiresAt, userAgent, remoteAddr }) { throw new Error('not implemented'); }
    async findSessionByTokenHash(tokenHash) { throw new Error('not implemented'); }
    async touchSession(id, { lastSeenAt, expiresAt }) { throw new Error('not implemented'); }
    async deleteSession(id) { throw new Error('not implemented'); }
    async deleteSessionsForUser(userId) { throw new Error('not implemented'); }
    async pruneExpiredSessions(now) { throw new Error('not implemented'); }

    // ---- servers ----------------------------------------------------------
    async listServers() { throw new Error('not implemented'); }
    async findServerById(id) { throw new Error('not implemented'); }
    async createServer({ name, host, port, password, notes }) { throw new Error('not implemented'); }
    async updateServer(id, fields) { throw new Error('not implemented'); }
    async deleteServer(id) { throw new Error('not implemented'); }

    // ---- rooms ------------------------------------------------------------
    async listRooms() { throw new Error('not implemented'); }
    async findRoomById(id) { throw new Error('not implemented'); }
    async findRoomByName(name) { throw new Error('not implemented'); }
    async createRoom(room) { throw new Error('not implemented'); }
    async updateRoom(id, fields) { throw new Error('not implemented'); }
    async deleteRoom(id) { throw new Error('not implemented'); }
    async listUsedPorts() { throw new Error('not implemented'); }

    // ---- events -----------------------------------------------------------
    async addEvent({ roomId, at, kind, detail, actor }) { throw new Error('not implemented'); }
    async listEvents({ roomId, limit }) { throw new Error('not implemented'); }
    async pruneEvents(olderThanMs) { throw new Error('not implemented'); }
}
