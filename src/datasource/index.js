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

export const SCHEMA_VERSION = 2;

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
 * Mappings: the console's whole subject matter. One row is ONE pair:
 *
 *     a local UDP port that players connect to  ->  one upstream room server
 *
 * That is the entire model. A row owns one gateway process; the gateway listens on
 * `local_port` for Citra clients and forwards the room traffic to
 * `target_host:target_port`, which is the Yuzu/room server's own address and port
 * (NOT a port on this machine). Version 1 of this schema split that pair into a
 * `servers` row plus a `rooms` row and derived the upstream port from a local pool,
 * which pointed the gateway at the wrong port; the pair is now one row precisely so
 * the two halves cannot drift apart.
 *
 *   id             integer primary key
 *   name           text unique friendly label, e.g. 'oku-1'
 *   local_port     integer unique 1..65535 -- the port players connect to
 *   target_host    text upstream room server host or IPv4 literal
 *   target_port    integer 1..65535 -- the upstream server's OWN port
 *   password       text upstream room password ('' means no password)
 *   listen_address text local bind address for the gateway
 *   capacity       integer DEPRECATED, always 0. The room server reports its own
 *                  member_slots after the gateway joins, so there is nothing for an
 *                  operator to configure. The column is kept so an existing database
 *                  still opens; the console neither writes nor displays it.
 *   profile        text 'default' | 'dual-host' | 'legacy'
 *   desired_state  text 'running' | 'stopped'
 *   state          text 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
 *   pid            integer | null
 *   failure        text
 *   started_at     integer ms | null
 *   stopped_at     integer ms | null
 *   extra_args     text JSON array of extra gateway arguments
 *   notes          text
 *   created_at / updated_at integer ms
 */
export const MAPPINGS_TABLE = 'mappings';

/**
 * Columns a caller may write on a mapping, and the camelCase aliases the route
 * layer uses. Shared by both SQL drivers so a field can never be writable through
 * one driver and silently ignored by the other.
 */
export const MAPPING_COLUMNS = Object.freeze([
    'name', 'local_port', 'target_host', 'target_port', 'password', 'listen_address',
    'capacity', 'profile', 'desired_state', 'state', 'pid', 'failure',
    'started_at', 'stopped_at', 'extra_args', 'notes',
]);

export const MAPPING_ALIASES = Object.freeze({
    localPort: 'local_port',
    targetHost: 'target_host',
    targetPort: 'target_port',
    listenAddress: 'listen_address',
    desiredState: 'desired_state',
    startedAt: 'started_at',
    stoppedAt: 'stopped_at',
    extraArgs: 'extra_args',
});

/**
 * Audit trail: append-only, for both mappings and console-level events.
 *   id         integer primary key
 *   mapping_id integer | null -> mappings.id (null for console events)
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

    // ---- mappings ---------------------------------------------------------
    /** All mappings, newest first. */
    async listMappings() { throw new Error('not implemented'); }
    /** One mapping, or null. */
    async findMappingById(id) { throw new Error('not implemented'); }
    /** One mapping by friendly name (used for the unique-name check), or null. */
    async findMappingByName(name) { throw new Error('not implemented'); }
    /**
     * Create a mapping. Every field of MAPPINGS_TABLE except id/timestamps may be
     * supplied; the driver fills sensible defaults for the process-state columns.
     * @returns {Promise<number>} the new mapping id
     */
    async createMapping(mapping) { throw new Error('not implemented'); }
    /** Partial update by id. Returns the number of rows changed. */
    async updateMapping(id, fields) { throw new Error('not implemented'); }
    /** Delete by id. Returns the number of rows removed. */
    async deleteMapping(id) { throw new Error('not implemented'); }
    /**
     * Local ports currently claimed by any mapping. The console uses this to pick a
     * free port when the operator leaves the field blank, and to refuse a duplicate.
     * @returns {Promise<number[]>}
     */
    async listUsedLocalPorts() { throw new Error('not implemented'); }

    // ---- events -----------------------------------------------------------
    /** `mappingId` is optional; omit it for console-level events. */
    async addEvent({ mappingId, at, kind, detail, actor }) { throw new Error('not implemented'); }
    /** Newest first. `mappingId` filters to one mapping when given. */
    async listEvents({ mappingId, limit }) { throw new Error('not implemented'); }
    async pruneEvents(olderThanMs) { throw new Error('not implemented'); }
}
