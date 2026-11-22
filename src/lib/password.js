// SPDX-License-Identifier: GPL-3.0-or-later
// Password hashing and verification.
//
// scrypt from node:crypto: no native dependency, no build step, and a memory-hard
// KDF that is appropriate for a console reachable from the internet. Parameters
// are stored in the hash string so they can be raised later without invalidating
// existing rows (verify() reads N/r/p from the record, not from the constants).

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// OWASP recommends N=2^17, r=8, p=1 for scrypt; that is ~128 MiB per hash. This
// console's login volume is tiny, so the cost is paid on first-run setup and on
// each login. maxmem must exceed 128 * N * r bytes.
export const SCRYPT_DEFAULTS = Object.freeze({ N: 1 << 17, r: 8, p: 1, keyLength: 64 });

function maxmemFor({ N, r }) {
    // 128 * N * r is the requirement; give it headroom.
    return 128 * N * r * 2;
}

/**
 * Hash a password into a self-describing string:
 *   scrypt$N=131072,r=8,p=1$<salt base64>$<key base64>
 */
export async function hashPassword(password, params = SCRYPT_DEFAULTS) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new TypeError('password must be a non-empty string');
    }
    const salt = randomBytes(16);
    const key = await scryptAsync(password.normalize('NFKC'), salt, params.keyLength, {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: maxmemFor(params),
    });
    return [
        'scrypt',
        `N=${params.N},r=${params.r},p=${params.p}`,
        salt.toString('base64'),
        key.toString('base64'),
    ].join('$');
}

/**
 * Constant-time verification. Returns false for any malformed stored hash rather
 * than throwing, so a corrupted row cannot turn into a 500 on the login path.
 */
export async function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const params = {};
    for (const pair of parts[1].split(',')) {
        const [key, value] = pair.split('=');
        if (!key || value === undefined) return false;
        params[key] = Number(value);
    }
    if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
    let salt;
    let expected;
    try {
        salt = Buffer.from(parts[2], 'base64');
        expected = Buffer.from(parts[3], 'base64');
    } catch {
        return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;
    let actual;
    try {
        actual = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
            N: params.N,
            r: params.r,
            p: params.p,
            maxmem: maxmemFor(params),
        });
    } catch {
        return false;
    }
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
}

/**
 * Password policy. Deliberately simple and explainable: no composition rules
 * (which push users toward "Password1!"), only a length floor plus a rejection of
 * the obvious weak values. The caller supplies the configured floor.
 */
export function checkPasswordStrength(password, { minLength = 10 } = {}) {
    if (typeof password !== 'string') return { ok: false, reason: '密码必须是字符串' };
    const normalised = password.normalize('NFKC');
    if (normalised.length < minLength) {
        return { ok: false, reason: `密码至少需要 ${minLength} 个字符` };
    }
    if (normalised.length > 256) return { ok: false, reason: '密码不能超过 256 个字符' };
    if (normalised.trim().length === 0) return { ok: false, reason: '密码不能全部是空白字符' };
    const lowered = normalised.toLowerCase();
    const obvious = new Set([
        'password', 'passw0rd', '12345678', '123456789', '1234567890',
        'admin', 'administrator', 'qwertyui', 'iloveyou', 'letmein',
        'mhxx', 'mhgu', 'mhg', 'monsterhunter',
    ]);
    if (obvious.has(lowered)) return { ok: false, reason: '这个密码太常见，请换一个' };
    const distinct = new Set(normalised).size;
    if (distinct < 3) return { ok: false, reason: '密码需要至少 3 种不同字符' };
    return { ok: true };
}
