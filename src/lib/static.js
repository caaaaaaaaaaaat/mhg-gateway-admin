// SPDX-License-Identifier: GPL-3.0-or-later
// Static file serving for the web console assets.
//
// The console ships a handful of files; this resolver is intentionally small but
// hard about two things: a request path can never escape the public directory
// (no `..`, no absolute paths, no symlinked parents), and only a whitelist of
// extensions is served, so a stray file in `public/` is not automatically
// published.

import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const MIME = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.ico', 'image/x-icon'],
    ['.webmanifest', 'application/manifest+json'],
    ['.txt', 'text/plain; charset=utf-8'],
]);

const SECURITY_HEADERS = {
    // No inline scripts or styles anywhere in public/: the console is a strict
    // CSP consumer, which makes an injected string much less useful.
    'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
};

/**
 * Resolve a URL pathname to a file inside `root`.
 * Returns null when the request must not be served.
 */
export function resolveStaticPath(root, pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    if (decoded.includes('\0')) return null;
    const relative = decoded === '/' ? '/index.html' : decoded;
    // Reject anything that is not a simple relative path before touching fs.
    if (!relative.startsWith('/')) return null;
    if (relative.split('/').some((part) => part === '..')) return null;
    const normalised = normalize(relative).replace(/^([/\\])+/, '');
    const full = join(root, normalised);
    // normalize() collapses `a/../../b`; verify the result stayed inside root.
    const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
    if (!full.startsWith(rootWithSep) && full !== root) return null;
    const mime = MIME.get(extname(full).toLowerCase());
    if (!mime) return null;
    let stats;
    try {
        stats = statSync(full);
    } catch {
        return null;
    }
    if (!stats.isFile()) return null;
    return { path: full, mime, size: stats.size, mtimeMs: stats.mtimeMs };
}

/**
 * Serve one request. Returns true when it handled the response.
 * `fallbackToIndex` makes unknown extension-less paths render the SPA shell, so a
 * deep link like /rooms/3 works on a refresh.
 */
export function serveStatic(req, res, { root, pathname, fallbackToIndex = true, extraHeaders = {} }) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let file = resolveStaticPath(root, pathname);
    if (!file && fallbackToIndex && !extname(pathname)) {
        file = resolveStaticPath(root, '/index.html');
    }
    if (!file) return false;

    const etag = `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
    const headers = {
        'Content-Type': file.mime,
        'Content-Length': file.size,
        ETag: etag,
        // The assets carry a build stamp in the URL query when needed; otherwise
        // revalidate so an upgrade is picked up without a hard refresh.
        'Cache-Control': file.mime.startsWith('text/html')
            ? 'no-store'
            : 'no-cache',
        ...SECURITY_HEADERS,
        ...extraHeaders,
    };
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return true;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    createReadStream(file.path).pipe(res);
    return true;
}

export { SECURITY_HEADERS, MIME };
