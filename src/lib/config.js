// SPDX-License-Identifier: GPL-3.0-or-later
// Configuration loading, defaults and validation.
//
// One JSON file (config.json), overridable per field through MHGA_* environment
// variables so the Docker image can be configured without mounting a file.
// Everything the project itself occupies (HTTP port, datasource, gateway port
// ranges, runtime directory) lives here; nothing is hard-coded at a call site.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';

export class ConfigError extends Error {
    constructor(message, path) {
        super(path ? `${path}: ${message}` : message);
        this.name = 'ConfigError';
        this.path = path ?? null;
    }
}

/** Built-in defaults. A missing config file means "all defaults". */
export function defaultConfig() {
    return {
        server: {
            host: '0.0.0.0',
            port: 8720,
            // Absolute base URL used when generating links in the UI. Empty
            // means "derive from the incoming request".
            publicUrl: '',
            trustProxy: false,
        },
        auth: {
            cookieName: 'mhg_admin_session',
            sessionTtlHours: 12,
            // A session slides forward on use, but never past this absolute cap.
            sessionMaxDays: 30,
            passwordMinLength: 10,
            // Failed logins before the account is locked for lockoutMinutes.
            maxFailedLogins: 8,
            lockoutMinutes: 15,
            // Stores the signing secret when a generated one is used.
            secretFile: 'data/session-secret',
            secureCookies: 'auto', // 'auto' | true | false
        },
        storage: {
            driver: 'sqlite', // 'sqlite' | 'mysql'
            sqlite: {
                path: 'data/mhg-gateway-admin.db',
            },
            mysql: {
                host: '127.0.0.1',
                port: 3306,
                user: 'mhg',
                password: '',
                database: 'mhg_gateway_admin',
                connectionLimit: 10,
                ssl: false,
                tablePrefix: '',
            },
        },
        gateways: {
            // Absolute path to a citra-gateway binary, or empty to search
            // PATH entries listed in binSearchPaths.
            binaryPath: '',
            // Optional command prefix used to run the binary, for a gateway
            // shipped as a script (`node`, `python3`, `wine`). Empty = exec
            // the binary directly, which is the normal case.
            interpreter: [],
            binSearchPaths: ['bin', '/usr/local/bin', '/usr/bin'],
            // Every room is given a Citra listener port and talks to one room
            // server port; both are allocated from these ranges.
            citraPortRange: [25000, 25999],
            roomPortRange: [24000, 24999],
            runtimeDir: 'data/rooms',
            // Extra CLI arguments appended to every launch (advanced use only).
            extraArgs: [],
            // Health sampling interval for the console's live view.
            sampleIntervalMs: 2000,
            // How long a stopped room's log is retained on disk (days).
            logRetentionDays: 7,
        },
        logging: {
            level: 'info', // debug | info | warn | error
            file: '', // empty = stdout
        },
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override, pathParts = []) {
    if (override === undefined) return base;
    if (override === null) return null;
    if (!isPlainObject(base) || !isPlainObject(override)) return override;
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        out[key] = deepMerge(base[key], value, [...pathParts, key]);
    }
    return out;
}

function requireInt(value, path, { min, max }) {
    const number = typeof value === 'string' ? Number(value) : value;
    if (!Number.isInteger(number)) throw new ConfigError(`must be an integer, got ${JSON.stringify(value)}`, path);
    if (number < min || number > max) throw new ConfigError(`must be within ${min}..${max}, got ${number}`, path);
    return number;
}

function requireString(value, path, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') throw new ConfigError(`must be a string, got ${typeof value}`, path);
    if (!allowEmpty && value.trim() === '') throw new ConfigError('must not be empty', path);
    return value;
}

function requirePortRange(value, path) {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new ConfigError('must be a [low, high] pair', path);
    }
    const low = requireInt(value[0], `${path}[0]`, { min: 1, max: 65535 });
    const high = requireInt(value[1], `${path}[1]`, { min: 1, max: 65535 });
    if (low >= high) throw new ConfigError('low bound must be below high bound', path);
    return [low, high];
}

/**
 * Validate a fully merged config and normalise relative paths against `root`.
 * Throws ConfigError with a dotted path so the operator can fix it directly.
 */
export function validateConfig(raw, { root = process.cwd() } = {}) {
    if (!isPlainObject(raw)) throw new ConfigError('config root must be an object');

    const server = raw.server ?? {};
    const auth = raw.auth ?? {};
    const storage = raw.storage ?? {};
    const gateways = raw.gateways ?? {};
    const logging = raw.logging ?? {};

    const driver = requireString(storage.driver ?? 'sqlite', 'storage.driver');
    if (driver !== 'sqlite' && driver !== 'mysql') {
        throw new ConfigError(`unsupported driver ${JSON.stringify(driver)} (expected sqlite or mysql)`, 'storage.driver');
    }

    const sqliteRaw = requireString(storage.sqlite?.path ?? 'data/mhg-gateway-admin.db', 'storage.sqlite.path');
    const runtimeDir = requireString(gateways.runtimeDir ?? 'data/rooms', 'gateways.runtimeDir');

    // SQLite's in-memory names are not filesystem paths: resolving them against
    // the config directory would silently turn ':memory:' into a relative file
    // called ':memory:'.
    const isSqliteMemory = sqliteRaw === ':memory:' || sqliteRaw.startsWith('file::memory:');
    const sqlitePath = isSqliteMemory ? sqliteRaw : (isAbsolute(sqliteRaw) ? sqliteRaw : resolve(root, sqliteRaw));

    const abs = (p) => (isAbsolute(p) ? p : resolve(root, p));

    const secureCookiesRaw = auth.secureCookies ?? 'auto';
    if (!(secureCookiesRaw === 'auto' || secureCookiesRaw === true || secureCookiesRaw === false)) {
        throw new ConfigError("must be 'auto', true or false", 'auth.secureCookies');
    }

    const level = requireString(logging.level ?? 'info', 'logging.level');
    if (!['debug', 'info', 'warn', 'error'].includes(level)) {
        throw new ConfigError(`unsupported level ${JSON.stringify(level)}`, 'logging.level');
    }

    const mysql = storage.mysql ?? {};
    const tablePrefix = mysql.tablePrefix ?? '';
    if (!/^[A-Za-z0-9_]*$/.test(tablePrefix)) {
        throw new ConfigError('only letters, digits and underscore are allowed', 'storage.mysql.tablePrefix');
    }

    return {
        root,
        server: {
            host: requireString(server.host ?? '0.0.0.0', 'server.host'),
            port: requireInt(server.port ?? 8720, 'server.port', { min: 1, max: 65535 }),
            publicUrl: String(server.publicUrl ?? '').replace(/\/+$/, ''),
            trustProxy: Boolean(server.trustProxy),
        },
        auth: {
            cookieName: requireString(auth.cookieName ?? 'mhg_admin_session', 'auth.cookieName'),
            sessionTtlHours: requireInt(auth.sessionTtlHours ?? 12, 'auth.sessionTtlHours', { min: 1, max: 24 * 30 }),
            sessionMaxDays: requireInt(auth.sessionMaxDays ?? 30, 'auth.sessionMaxDays', { min: 1, max: 3650 }),
            passwordMinLength: requireInt(auth.passwordMinLength ?? 10, 'auth.passwordMinLength', { min: 8, max: 256 }),
            maxFailedLogins: requireInt(auth.maxFailedLogins ?? 8, 'auth.maxFailedLogins', { min: 1, max: 1000 }),
            lockoutMinutes: requireInt(auth.lockoutMinutes ?? 15, 'auth.lockoutMinutes', { min: 1, max: 10080 }),
            secretFile: abs(requireString(auth.secretFile ?? 'data/session-secret', 'auth.secretFile')),
            secureCookies: secureCookiesRaw,
        },
        storage: {
            driver,
            sqlite: { path: sqlitePath },
            mysql: {
                host: requireString(mysql.host ?? '127.0.0.1', 'storage.mysql.host'),
                port: requireInt(mysql.port ?? 3306, 'storage.mysql.port', { min: 1, max: 65535 }),
                user: requireString(mysql.user ?? 'mhg', 'storage.mysql.user'),
                password: String(mysql.password ?? ''),
                database: requireString(mysql.database ?? 'mhg_gateway_admin', 'storage.mysql.database'),
                connectionLimit: requireInt(mysql.connectionLimit ?? 10, 'storage.mysql.connectionLimit', { min: 1, max: 200 }),
                ssl: Boolean(mysql.ssl),
                tablePrefix,
            },
        },
        gateways: {
            binaryPath: gateways.binaryPath ? abs(requireString(gateways.binaryPath, 'gateways.binaryPath')) : '',
            // A string is accepted as shorthand for a one-argument prefix, so
            // `"interpreter": "node"` reads naturally in the config file.
            interpreter: (() => {
                const raw = gateways.interpreter;
                if (raw === undefined || raw === null || raw === '') return [];
                if (typeof raw === 'string') return [requireString(raw, 'gateways.interpreter')];
                if (!Array.isArray(raw)) {
                    throw new ConfigError('must be a string or an array of strings', 'gateways.interpreter');
                }
                return raw.map((entry, index) => requireString(entry, `gateways.interpreter[${index}]`));
            })(),
            binSearchPaths: Array.isArray(gateways.binSearchPaths) && gateways.binSearchPaths.length
                ? gateways.binSearchPaths.map((entry, index) => abs(requireString(entry, `gateways.binSearchPaths[${index}]`)))
                : [abs('bin'), '/usr/local/bin', '/usr/bin'],
            citraPortRange: requirePortRange(gateways.citraPortRange ?? [25000, 25999], 'gateways.citraPortRange'),
            roomPortRange: requirePortRange(gateways.roomPortRange ?? [24000, 24999], 'gateways.roomPortRange'),
            runtimeDir: abs(runtimeDir),
            extraArgs: Array.isArray(gateways.extraArgs) ? gateways.extraArgs.map((a, i) => requireString(a, `gateways.extraArgs[${i}]`, { allowEmpty: true })) : [],
            sampleIntervalMs: requireInt(gateways.sampleIntervalMs ?? 2000, 'gateways.sampleIntervalMs', { min: 250, max: 600000 }),
            logRetentionDays: requireInt(gateways.logRetentionDays ?? 7, 'gateways.logRetentionDays', { min: 1, max: 3650 }),
        },
        logging: {
            level,
            file: logging.file ? abs(requireString(logging.file, 'logging.file')) : '',
        },
    };
}

/**
 * Environment overrides. Only the knobs an operator realistically sets on a
 * server are exposed; everything else stays in config.json.
 */
export function envOverrides(env = process.env) {
    const out = {};
    const set = (path, value) => {
        if (value === undefined || value === '') return;
        const parts = path.split('.');
        let node = out;
        for (const part of parts.slice(0, -1)) {
            node[part] = node[part] ?? {};
            node = node[part];
        }
        node[parts.at(-1)] = value;
    };
    set('server.host', env.MHGA_HOST);
    set('server.port', env.MHGA_PORT);
    set('server.publicUrl', env.MHGA_PUBLIC_URL);
    if (env.MHGA_TRUST_PROXY) set('server.trustProxy', ['1', 'true', 'yes'].includes(env.MHGA_TRUST_PROXY.toLowerCase()));
    set('storage.driver', env.MHGA_DB_DRIVER);
    set('storage.sqlite.path', env.MHGA_SQLITE_PATH);
    set('storage.mysql.host', env.MHGA_MYSQL_HOST);
    set('storage.mysql.port', env.MHGA_MYSQL_PORT);
    set('storage.mysql.user', env.MHGA_MYSQL_USER);
    set('storage.mysql.password', env.MHGA_MYSQL_PASSWORD);
    set('storage.mysql.database', env.MHGA_MYSQL_DATABASE);
    set('storage.mysql.tablePrefix', env.MHGA_MYSQL_TABLE_PREFIX);
    set('gateways.binaryPath', env.MHGA_GATEWAY_BIN);
    set('gateways.runtimeDir', env.MHGA_RUNTIME_DIR);
    set('logging.level', env.MHGA_LOG_LEVEL);
    set('logging.file', env.MHGA_LOG_FILE);
    return out;
}

/**
 * Load config from an optional file plus environment overrides.
 * A missing file is not an error: defaults + environment are a valid setup.
 */
export function loadConfig({ file = null, env = process.env, root = process.cwd() } = {}) {
    const configPath = file ?? env.MHGA_CONFIG ?? resolve(root, 'config.json');
    let fileConfig = {};
    if (existsSync(configPath)) {
        let text;
        try {
            text = readFileSync(configPath, 'utf8');
        } catch (error) {
            throw new ConfigError(`cannot read config file: ${error.message}`);
        }
        // Windows editors (Notepad, PowerShell `Set-Content -Encoding UTF8`) write a
        // UTF-8 BOM, and JSON.parse rejects it. Strip it rather than making the
        // operator discover an invisible character.
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        try {
            fileConfig = JSON.parse(text);
        } catch (error) {
            throw new ConfigError(`invalid JSON in ${configPath}: ${error.message}`);
        }
        if (!isPlainObject(fileConfig)) throw new ConfigError('config root must be an object');
    }
    const merged = deepMerge(deepMerge(defaultConfig(), fileConfig), envOverrides(env));
    const config = validateConfig(merged, { root: isAbsolute(configPath) ? dirname(configPath) : root });
    config.configPath = existsSync(configPath) ? configPath : null;
    return config;
}
