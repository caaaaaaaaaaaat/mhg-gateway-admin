// SPDX-License-Identifier: GPL-3.0-or-later
// Application assembly: build the HTTP server from config, datasource, auth and
// supervisor.
//
// Kept separate from src/index.js so tests can construct a server on an ephemeral
// port with an in-memory datasource and a fake spawn implementation.

import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, HttpError, sendJson, sendError, sendText } from './lib/http.js';
import { AuthService } from './lib/auth.js';
import { createApiRoutes } from './routes/api.js';
import { serveStatic, SECURITY_HEADERS } from './lib/static.js';
import { createLogger } from './lib/logger.js';

// src/app.js lives directly inside the project root, so `public/` is its sibling.
const here = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(here, '..', 'public');

/**
 * @param {object} options
 * @param {object} options.config      validated config
 * @param {object} options.datasource  initialised Datasource
 * @param {object} options.supervisor  GatewaySupervisor
 * @param {object} [options.logger]
 * @param {string} [options.publicDir]
 */
export function createApp({ config, datasource, supervisor, logger, publicDir = PUBLIC_DIR }) {
    const log = logger ?? createLogger({ level: config.logging.level, file: config.logging.file });
    const auth = new AuthService({ config, datasource, logger: log });
    const router = new Router();
    createApiRoutes({ router, auth, datasource, supervisor, config, logger: log });

    const server = createServer(async (req, res) => {
        // One place sets the security headers so no response path can forget them.
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
            res.setHeader(name, value);
        }
        res.setHeader('X-DNS-Prefetch-Control', 'off');
        const started = Date.now();
        let pathname = '/';
        try {
            const url = new URL(req.url ?? '/', 'http://internal');
            pathname = url.pathname;
            const matched = router.match(req.method ?? 'GET', pathname);
            if (matched && matched.allowed) {
                sendJson(res, 405, {
                    error: { message: '方法不允许', code: 'method_not_allowed', details: { allowed: matched.allowed } },
                }, { Allow: matched.allowed.join(', ') });
                return;
            }
            if (matched) {
                const context = await auth.authenticate(req);
                // CSRF is enforced centrally for every mutating request on a route
                // that requires a session. Routes marked `public` are the pre-auth
                // entry points (setup, login, logout, health) which have no session
                // to bind a token to; a forged setup or login gains nothing.
                if (!matched.route.options.public) auth.assertCsrf(req, context);
                await matched.route.handler(req, res, {
                    ...(matched.params ?? {}),
                    params: matched.params ?? {},
                    context,
                    user: context?.user ?? null,
                });
                return;
            }
            // API paths never fall through to the SPA shell: a mistyped endpoint
            // must be a visible JSON 404 rather than 200 with an HTML page, which
            // would make a broken client look like it worked.
            if (pathname === '/api' || pathname.startsWith('/api/')) {
                sendJson(res, 404, { error: { message: '未找到该接口', code: 'not_found' } });
                return;
            }
            if (serveStatic(req, res, { root: publicDir, pathname })) return;
            sendJson(res, 404, { error: { message: '未找到该地址', code: 'not_found' } });
        } catch (error) {
            if (error instanceof HttpError) {
                sendError(res, error, log);
            } else if (error && error.statusCode) {
                // Datasource/validation layers may raise plain errors with a code.
                sendJson(res, error.statusCode, {
                    error: { message: error.message, code: error.code ?? 'error' },
                });
            } else {
                sendError(res, error, log);
            }
        } finally {
            log.debug('request', {
                method: req.method,
                path: pathname,
                status: res.statusCode,
                ms: Date.now() - started,
            });
        }
    });

    // Do not advertise the server implementation.
    server.headersTimeout = 20_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;

    return { server, auth, router, logger: log };
}

export { sendText };
