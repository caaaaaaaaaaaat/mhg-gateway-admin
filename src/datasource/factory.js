// SPDX-License-Identifier: GPL-3.0-or-later
// Datasource factory. One entry point so the rest of the program never imports a
// concrete driver and a new backend is a single file plus one case here.

import { SqliteDatasource } from './sqlite.js';
import { MysqlDatasource } from './mysql.js';

export { Datasource, SCHEMA_VERSION } from './index.js';

/**
 * Build (but do not open) the configured datasource.
 * Caller is expected to await ds.init() and to surface failures at startup.
 */
export function createDatasource(config) {
    const driver = config.storage.driver;
    if (driver === 'sqlite') {
        return new SqliteDatasource({ path: config.storage.sqlite.path });
    }
    if (driver === 'mysql') {
        return new MysqlDatasource(config.storage.mysql);
    }
    throw new Error(`unknown datasource driver: ${driver}`);
}
