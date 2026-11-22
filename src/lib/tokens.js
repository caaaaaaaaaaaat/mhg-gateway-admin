// SPDX-License-Identifier: GPL-3.0-or-later
// Session tokens and CSRF tokens.
//
// Design: opaque random session ids, never JWTs. The database stores only the
// SHA-256 of the id, so a leaked database dump cannot be replayed as a session.
// Everything the gateway needs to identify a caller is therefore a server-side
// lookup, which also makes "revoke all sessions" a single UPDATE.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_TOKEN_BYTES = 32;
export const CSRF_TOKEN_BYTES = 32;

/** A URL-safe random token. */
export function randomToken(bytes = SESSION_TOKEN_BYTES) {
    return randomBytes(bytes).toString('base64url');
}

/** The lookup key stored in the datasource. */
export function hashToken(token) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison for CSRF tokens of arbitrary length. */
export function tokensEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length || left.length === 0) return false;
    return timingSafeEqual(left, right);
}

/**
 * Parse a Cookie header into a plain object. Later duplicates win, matching
 * browser behaviour when the same name is set for different paths.
 */
export function parseCookies(header) {
    const out = Object.create(null);
    if (typeof header !== 'string' || header === '') return out;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        const name = part.slice(0, index).trim();
        if (!name) continue;
        let value = part.slice(index + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
            value = value.slice(1, -1);
        }
        try {
            out[name] = decodeURIComponent(value);
        } catch {
            out[name] = value;
        }
    }
    return out;
}

/**
 * Serialise a Set-Cookie value.
 * httpOnly + SameSite=Lax + (Secure when TLS) is the console's baseline: Lax keeps
 * the cookie on top-level navigations so a bookmarked URL still works, while
 * cross-site POSTs do not carry it.
 */
export function serialiseCookie(name, value, options = {}) {
    const {
        maxAgeSeconds,
        path = '/',
        httpOnly = true,
        sameSite = 'Lax',
        secure = false,
        expires,
    } = options;
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
    if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
    if (expires instanceof Date) parts.push(`Expires=${expires.toUTCString()}`);
    if (httpOnly) parts.push('HttpOnly');
    if (sameSite) parts.push(`SameSite=${sameSite}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

/** A cleared cookie (same attributes, empty value, immediate expiry). */
export function clearedCookie(name, options = {}) {
    return serialiseCookie(name, '', { ...options, maxAgeSeconds: 0 });
}
