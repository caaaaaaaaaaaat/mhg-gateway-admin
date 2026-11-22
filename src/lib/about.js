// SPDX-License-Identifier: GPL-3.0-or-later
// Static identity of this build: who wrote it, where the source lives, and which
// version is running.
//
// The version is read from package.json rather than duplicated, so `npm version` and
// the footer in the console can never disagree. The author block mirrors the desktop
// gateway's About dialog (gateway-gui/src/main.cpp) so both halves of the project
// identify themselves the same way.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/** @type {{name: string, version: string, author: string, qq: string, qqGroup: string, repo: string, license: string}} */
export const ABOUT = Object.freeze({
    name: 'MHXX/MHGU 网关批量管理控制台',
    version: pkg.version,
    // Same author line as the Windows gateway's About window.
    author: '小忆',
    qq: '1726956536',
    qqGroup: '741115244',
    repo: 'https://github.com/caaaaaaaaaaaat/mhg-gateway-admin',
    license: 'GPL-3.0-or-later',
});
