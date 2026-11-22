// SPDX-License-Identifier: GPL-3.0-or-later
// A small router and request/response helpers.
//
// Hand-rolled on node:http on purpose: the console has ~20 endpoints, and a
// framework would add a dependency tree and its own body-parsing/CVE surface for
// no functional gain. What a framework *would* give us -- routing, JSON bodies
// with a size cap, uniform error responses -- is implemented here explicitly.

import { STATUS_CODES } from 'node:http';

const MAX_BODY_BYTES = 256 * 1024;

export class HttpError extends Error {
    constructor(statusCode, message, { code = null, details = null } = {}) {
        super(message);
        this.name = 'HttpError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}

/** Route table: pattern segments, `:name` captures, exact method match. */
export class Router {
    constructor() {
        this.routes = [];
    }

    /**
     * Register a route.
     * Accepts either (method, pattern, handler, options) or the shorthand
     * (method, pattern, options, handler) used by routes that need options to read
     * clearly, e.g. router.get('/api/health', { public: true }, handler).
     */
    add(method, pattern, handlerOrOptions, optionsOrHandler) {
        let handler;
        let options;
        if (typeof handlerOrOptions === 'function') {
            handler = handlerOrOptions;
            options = optionsOrHandler ?? {};
        } else {
            options = handlerOrOptions ?? {};
            handler = optionsOrHandler;
        }
        if (typeof handler !== 'function') {
            throw new TypeError(`route ${method} ${pattern} has no handler`);
        }
        const segments = pattern.split('/').filter((part) => part !== '');
        this.routes.push({ method: method.toUpperCase(), segments, handler, options });
        return this;
    }

    get(pattern, handlerOrOptions, optionsOrHandler) {
        return this.add('GET', pattern, handlerOrOptions, optionsOrHandler);
    }
    post(pattern, handlerOrOptions, optionsOrHandler) {
        return this.add('POST', pattern, handlerOrOptions, optionsOrHandler);
    }
    put(pattern, handlerOrOptions, optionsOrHandler) {
        return this.add('PUT', pattern, handlerOrOptions, optionsOrHandler);
    }
    patch(pattern, handlerOrOptions, optionsOrHandler) {
        return this.add('PATCH', pattern, handlerOrOptions, optionsOrHandler);
    }
    delete(pattern, handlerOrOptions, optionsOrHandler) {
        return this.add('DELETE', pattern, handlerOrOptions, optionsOrHandler);
    }

    /**
     * Find a route and extract params.
     * Returns { route, params } or { allowed } for a 405, or null for a 404 so the
     * caller can fall through to static files.
     */
    match(method, pathname) {
        const parts = pathname.split('/').filter((part) => part !== '');
        const allowed = new Set();
        for (const route of this.routes) {
            const params = matchSegments(route.segments, parts);
            if (params === null) continue;
            if (route.method !== method.toUpperCase()) {
                allowed.add(route.method);
                continue;
            }
            return { route, params };
        }
        return allowed.size > 0 ? { allowed: [...allowed] } : null;
    }
}

function matchSegments(patternSegments, pathSegments) {
    if (patternSegments.length !== pathSegments.length) return null;
    const params = {};
    for (let index = 0; index < patternSegments.length; index += 1) {
        const pattern = patternSegments[index];
        const value = pathSegments[index];
        if (pattern.startsWith(':')) {
            params[pattern.slice(1)] = decodeURIComponent(value);
            continue;
        }
        if (pattern !== value) return null;
    }
    return params;
}

/** Read a JSON body with a hard size cap. An empty body is `{}`. */
export async function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
    const type = String(req.headers['content-type'] ?? '');
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > limit) {
            throw new HttpError(413, '请求体过大', { code: 'body_too_large' });
        }
        chunks.push(chunk);
    }
    if (total === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (type && !type.includes('application/json')) {
        // Tolerate a missing type but not an obviously wrong one: an HTML form
        // post must not be silently interpreted as JSON.
        throw new HttpError(415, '只接受 application/json 请求体', { code: 'unsupported_media_type' });
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new HttpError(400, '请求体必须是 JSON 对象', { code: 'invalid_body' });
        }
        return parsed;
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, '请求体不是合法 JSON', { code: 'invalid_json' });
    }
}

/** Send a JSON response. */
export function sendJson(res, statusCode, payload, headers = {}) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
    });
    res.end(body);
}

/** Send a plain-text response (used by /healthz). */
export function sendText(res, statusCode, text, headers = {}) {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        ...headers,
    });
    res.end(body);
}

/** Uniform error serialisation. Unknown errors become a 500 without internals. */
export function sendError(res, error, logger = null) {
    if (error instanceof HttpError) {
        sendJson(res, error.statusCode, {
            error: {
                message: error.message,
                code: error.code ?? STATUS_CODES[error.statusCode] ?? 'error',
                ...(error.details ? { details: error.details } : {}),
            },
        });
        return;
    }
    logger?.error('unhandled request error', { error: error?.message, stack: error?.stack });
    sendJson(res, 500, {
        error: { message: '服务器内部错误', code: 'internal_error' },
    });
}

/** Redirect helper. */
export function sendRedirect(res, location, statusCode = 303, headers = {}) {
    res.writeHead(statusCode, { Location: location, 'Cache-Control': 'no-store', ...headers });
    res.end();
}

export { MAX_BODY_BYTES };
