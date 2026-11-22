// SPDX-License-Identifier: GPL-3.0-or-later
// config.js: defaults, merge precedence, validation errors and path resolution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    defaultConfig, loadConfig, validateConfig, envOverrides, ConfigError,
} from '../src/lib/config.js';

test('defaultConfig is valid and complete', () => {
    const config = validateConfig(defaultConfig(), { root: '/tmp/x' });
    assert.equal(config.server.port, 8720);
    assert.equal(config.storage.driver, 'sqlite');
    assert.equal(config.auth.sessionTtlHours, 12);
    assert.equal(config.gateways.localPortRange[0], 25000);
    assert.deepEqual(config.gateways.localPortRange, [25000, 25999]);
    assert.equal(config.logging.level, 'info');
});

test('a missing file is not an error and yields defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-cfg-'));
    try {
        const config = loadConfig({ file: join(root, 'nope.json'), env: {}, root });
        assert.equal(config.configPath, null);
        assert.equal(config.server.port, 8720);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('file values override defaults, environment overrides the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-cfg-'));
    try {
        const path = join(root, 'config.json');
        writeFileSync(path, JSON.stringify({ server: { port: 9000 }, storage: { driver: 'sqlite' } }));
        const fromFile = loadConfig({ file: path, env: {}, root });
        assert.equal(fromFile.server.port, 9000);
        assert.equal(fromFile.server.host, '0.0.0.0', 'unspecified field keeps the default');

        const fromEnv = loadConfig({
            file: path,
            env: { MHGA_PORT: '9100', MHGA_LOG_LEVEL: 'debug' },
            root,
        });
        assert.equal(fromEnv.server.port, 9100, 'environment wins over the file');
        assert.equal(fromEnv.logging.level, 'debug');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('relative paths resolve against the config file directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-cfg-'));
    try {
        const path = join(root, 'config.json');
        writeFileSync(path, JSON.stringify({
            storage: { sqlite: { path: 'db/app.db' } },
            gateways: { runtimeDir: 'run' },
        }));
        const config = loadConfig({ file: path, env: {}, root: process.cwd() });
        assert.equal(config.storage.sqlite.path, join(root, 'db', 'app.db'));
        assert.equal(config.gateways.runtimeDir, join(root, 'run'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('invalid JSON reports the file path', () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-cfg-'));
    try {
        const path = join(root, 'config.json');
        writeFileSync(path, '{ this is not json ');
        assert.throws(() => loadConfig({ file: path, env: {}, root }), (error) => {
            assert.ok(error instanceof ConfigError);
            assert.match(error.message, /invalid JSON/);
            return true;
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('validation rejects out-of-range and unknown values with dotted paths', () => {
    const cases = [
        [{ server: { port: 0 } }, 'server.port'],
        [{ server: { port: 70000 } }, 'server.port'],
        [{ storage: { driver: 'postgres' } }, 'storage.driver'],
        [{ gateways: { localPortRange: [26000, 25000] } }, 'gateways.localPortRange'],
        [{ gateways: { localPortRange: [1] } }, 'gateways.localPortRange'],
        [{ logging: { level: 'verbose' } }, 'logging.level'],
        [{ auth: { secureCookies: 'sometimes' } }, 'auth.secureCookies'],
        [{ auth: { passwordMinLength: 4 } }, 'auth.passwordMinLength'],
        [{ storage: { mysql: { tablePrefix: 'bad-prefix' } } }, 'storage.mysql.tablePrefix'],
        [{ auth: { sessionTtlHours: 0 } }, 'auth.sessionTtlHours'],
    ];
    for (const [override, expectedPath] of cases) {
        const merged = { ...defaultConfig(), ...override };
        assert.throws(() => validateConfig(merged, { root: '/tmp' }), (error) => {
            assert.ok(error instanceof ConfigError, `${JSON.stringify(override)} should be a ConfigError`);
            assert.equal(error.path, expectedPath);
            return true;
        }, `${JSON.stringify(override)} should be rejected`);
    }
});

test('envOverrides ignores empty values and parses booleans', () => {
    const overrides = envOverrides({
        MHGA_PORT: '',
        MHGA_HOST: '10.0.0.5',
        MHGA_TRUST_PROXY: 'true',
        MHGA_MYSQL_PORT: '3307',
    });
    assert.equal(overrides.server.port, undefined, 'empty string must not override');
    assert.equal(overrides.server.host, '10.0.0.5');
    assert.equal(overrides.server.trustProxy, true);
    assert.equal(overrides.storage.mysql.port, '3307', 'string is coerced later by validation');
});

test('mysql settings validate without needing the driver installed', () => {
    const config = validateConfig({
        ...defaultConfig(),
        storage: { driver: 'mysql', mysql: { host: 'db.local', port: 3307, user: 'u', database: 'd' } },
    }, { root: '/tmp/x' });
    assert.equal(config.storage.driver, 'mysql');
    assert.equal(config.storage.mysql.host, 'db.local');
    assert.equal(config.storage.mysql.port, 3307);
});

test('deep merge keeps sibling defaults inside a partially overridden block', () => {
    const root = mkdtempSync(join(tmpdir(), 'mhga-cfg-'));
    try {
        const path = join(root, 'config.json');
        writeFileSync(path, JSON.stringify({ auth: { sessionTtlHours: 3 } }));
        const config = loadConfig({ file: path, env: {}, root });
        assert.equal(config.auth.sessionTtlHours, 3);
        assert.equal(config.auth.maxFailedLogins, 8, 'untouched sibling keeps its default');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
