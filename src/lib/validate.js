// SPDX-License-Identifier: GPL-3.0-or-later
// Input validation helpers shared by the routes.
//
// Every mutating endpoint validates through these, so a bad value produces a
// field-specific 400 instead of a database error or, worse, an argument that
// reaches a spawned process.

import { HttpError } from './http.js';

export function requireString(value, field, { min = 1, max = 255, trim = true, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        throw new HttpError(400, `${field} 不能为空`, { code: 'invalid_field', details: { field } });
    }
    if (typeof value !== 'string') {
        throw new HttpError(400, `${field} 必须是字符串`, { code: 'invalid_field', details: { field } });
    }
    const text = trim ? value.trim() : value;
    if (!allowEmpty && text.length === 0) {
        throw new HttpError(400, `${field} 不能为空`, { code: 'invalid_field', details: { field } });
    }
    if (text.length < min) {
        throw new HttpError(400, `${field} 至少需要 ${min} 个字符`, { code: 'invalid_field', details: { field } });
    }
    if (text.length > max) {
        throw new HttpError(400, `${field} 不能超过 ${max} 个字符`, { code: 'invalid_field', details: { field } });
    }
    return text;
}

export function requirePort(value, field) {
    const number = typeof value === 'string' ? Number(value) : value;
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
        throw new HttpError(400, `${field} 必须是 1-65535 之间的整数`, { code: 'invalid_field', details: { field } });
    }
    return number;
}

/**
 * Room/server names appear in URLs, log paths and process listings, so they are
 * restricted to a conservative character set rather than merely escaped.
 */
export function requireName(value, field, { max = 32 } = {}) {
    const text = requireString(value, field, { min: 1, max });
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(text)) {
        throw new HttpError(400, `${field} 只能包含字母、数字、空格、下划线、点和短横线`, {
            code: 'invalid_field',
            details: { field },
        });
    }
    return text;
}

/**
 * A host is either an IPv4 literal, a bracketed/plain IPv6 literal or a DNS name.
 * The value is never resolved here; the gateway does that at join time.
 */
export function requireHost(value, field) {
    const text = requireString(value, field, { min: 1, max: 253 });
    if (text.includes('/') || text.includes('\\')) {
        throw new HttpError(400, `${field} 不能包含协议或路径`, { code: 'invalid_field', details: { field } });
    }
    // A port belongs in the separate field. Bare IPv6 addresses legitimately contain
    // colons, so only forms that cannot be IPv6 are rejected here. An IPv6 literal
    // always has at least two colons (`::1`, `fe80::1`, `2001:db8::1`); a single
    // colon is always `host:port`, which the caller must split itself.
    const colonCount = (text.match(/:/g) ?? []).length;
    const looksLikeIpv6 = text.startsWith('[') || colonCount >= 2;
    if (text.includes(':') && !looksLikeIpv6) {
        throw new HttpError(400, `${field} 不要带端口，端口请填在单独的字段里`, {
            code: 'invalid_field', details: { field },
        });
    }
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = ipv4.exec(text);
    if (match) {
        const parts = match.slice(1).map(Number);
        if (parts.some((part) => part > 255)) {
            throw new HttpError(400, `${field} 不是合法的 IPv4 地址`, { code: 'invalid_field', details: { field } });
        }
        return text;
    }
    if (text.startsWith('[') && text.endsWith(']')) {
        const inner = text.slice(1, -1);
        if (!/^[0-9A-Fa-f:.]+$/.test(inner)) {
            throw new HttpError(400, `${field} 不是合法的 IPv6 地址`, { code: 'invalid_field', details: { field } });
        }
        return text;
    }
    if (/^[0-9A-Fa-f:.]+$/.test(text) && text.includes(':')) return text;
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(text)) {
        throw new HttpError(400, `${field} 不是合法的地址或域名`, { code: 'invalid_field', details: { field } });
    }
    return text;
}

/** Room passwords are copied verbatim to the gateway; only the length is bounded. */
export function optionalPassword(value, field, { max = 128 } = {}) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new HttpError(400, `${field} 必须是字符串`, { code: 'invalid_field', details: { field } });
    }
    if (value.length > max) {
        throw new HttpError(400, `${field} 不能超过 ${max} 个字符`, { code: 'invalid_field', details: { field } });
    }
    return value;
}

export function optionalText(value, field, { max = 1024 } = {}) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new HttpError(400, `${field} 必须是字符串`, { code: 'invalid_field', details: { field } });
    }
    if (value.length > max) {
        throw new HttpError(400, `${field} 不能超过 ${max} 个字符`, { code: 'invalid_field', details: { field } });
    }
    return value;
}

export function requireId(value, field = 'id') {
    const number = typeof value === 'string' ? Number(value) : value;
    if (!Number.isInteger(number) || number <= 0) {
        throw new HttpError(400, `${field} 不合法`, { code: 'invalid_field', details: { field } });
    }
    return number;
}

export function requireEnum(value, field, allowed) {
    if (!allowed.includes(value)) {
        throw new HttpError(400, `${field} 只能是 ${allowed.join(' / ')}`, {
            code: 'invalid_field',
            details: { field, allowed },
        });
    }
    return value;
}

/** A listen address for the gateway: wildcard, loopback or a specific IPv4. */
export function requireListenAddress(value, field = 'listenAddress') {
    const text = requireString(value ?? '0.0.0.0', field, { min: 7, max: 15 });
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)) {
        throw new HttpError(400, `${field} 必须是 IPv4 地址，例如 0.0.0.0`, {
            code: 'invalid_field',
            details: { field },
        });
    }
    const parts = text.split('.').map(Number);
    if (parts.some((part) => part > 255)) {
        throw new HttpError(400, `${field} 不是合法的 IPv4 地址`, { code: 'invalid_field', details: { field } });
    }
    return text;
}
