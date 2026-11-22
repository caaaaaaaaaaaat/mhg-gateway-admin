// SPDX-License-Identifier: GPL-3.0-or-later
// password.js + tokens.js: the security primitives, tested directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    hashPassword, verifyPassword, checkPasswordStrength, SCRYPT_DEFAULTS,
} from '../src/lib/password.js';
import {
    randomToken, hashToken, tokensEqual, parseCookies, serialiseCookie, clearedCookie,
} from '../src/lib/tokens.js';

// scrypt with the production parameters costs ~100ms each; these tests use a
// cheaper profile so the suite stays fast, and one test asserts the real cost
// parameters are what the hash string records.
const FAST = { N: 1 << 12, r: 8, p: 1, keyLength: 32 };

test('hash is self-describing and verifies', async () => {
    const stored = await hashPassword('correct horse battery', FAST);
    const parts = stored.split('$');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'scrypt');
    assert.match(parts[1], /^N=4096,r=8,p=1$/);
    assert.ok(await verifyPassword('correct horse battery', stored));
    assert.equal(await verifyPassword('correct horse batteru', stored), false);
    assert.equal(await verifyPassword('', stored), false);
});

test('each hash uses a fresh salt', async () => {
    const a = await hashPassword('same-password-value', FAST);
    const b = await hashPassword('same-password-value', FAST);
    assert.notEqual(a, b, 'two hashes of the same password must differ');
    assert.ok(await verifyPassword('same-password-value', a));
    assert.ok(await verifyPassword('same-password-value', b));
});

test('verification parameters come from the stored string, not the constants', async () => {
    // A hash created with weaker parameters must still verify after an upgrade,
    // otherwise raising the cost would lock every operator out.
    const weak = await hashPassword('legacy-shape-password', { N: 1 << 10, r: 8, p: 1, keyLength: 32 });
    assert.match(weak.split('$')[1], /N=1024/);
    assert.ok(await verifyPassword('legacy-shape-password', weak));
    assert.ok(SCRYPT_DEFAULTS.N >= 1 << 16, 'the default cost must be strong');
});

test('malformed stored hashes are rejected without throwing', async () => {
    for (const stored of [
        '', 'not-a-hash', 'scrypt$N=x,r=8,p=1$aa$bb', 'bcrypt$N=1024,r=8,p=1$aa$bb',
        'scrypt$N=1024$aa$bb', 'scrypt$N=1024,r=8,p=1$$', 'scrypt$N=1024,r=8,p=1$aa$',
    ]) {
        assert.equal(await verifyPassword('anything', stored), false, `should reject ${JSON.stringify(stored)}`);
    }
    assert.equal(await verifyPassword('anything', null), false);
    assert.equal(await verifyPassword(null, 'scrypt$x$y$z'), false);
});

test('unicode passwords normalise consistently', async () => {
    // NFC and NFD forms of the same text must verify against one hash, so a
    // password typed on a different OS still works.
    const nfc = 'pässwörd-ünïcode-1';
    const nfd = nfc.normalize('NFD');
    const stored = await hashPassword(nfc, FAST);
    assert.ok(await verifyPassword(nfd, stored));
});

test('password policy: length floor, obvious values, entropy floor', () => {
    assert.equal(checkPasswordStrength('short', { minLength: 10 }).ok, false);
    assert.match(checkPasswordStrength('short', { minLength: 10 }).reason, /10/);
    assert.equal(checkPasswordStrength('Password', { minLength: 8 }).ok, false, 'common word');
    assert.equal(checkPasswordStrength('aaaaaaaaaa', { minLength: 10 }).ok, false, 'too few distinct chars');
    assert.equal(checkPasswordStrength('          ', { minLength: 10 }).ok, false, 'whitespace only');
    assert.equal(checkPasswordStrength('a'.repeat(300), { minLength: 10 }).ok, false, 'too long');
    assert.equal(checkPasswordStrength('Correct-Horse-9', { minLength: 10 }).ok, true);
    assert.equal(checkPasswordStrength('怪物猎人-跨平台-2026', { minLength: 10 }).ok, true, 'CJK is allowed');
});

test('randomToken is URL-safe and unique', () => {
    const seen = new Set();
    for (let index = 0; index < 200; index += 1) {
        const token = randomToken();
        assert.match(token, /^[A-Za-z0-9_-]+$/);
        assert.ok(token.length >= 40);
        assert.equal(seen.has(token), false);
        seen.add(token);
    }
});

test('hashToken is a stable hex digest, not reversible', () => {
    const token = randomToken();
    const digest = hashToken(token);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(hashToken(token), digest);
    assert.notEqual(hashToken(`${token}x`), digest);
    assert.equal(digest.includes(token), false);
});

test('tokensEqual compares without leaking length-dependent timing', () => {
    assert.equal(tokensEqual('abc', 'abc'), true);
    assert.equal(tokensEqual('abc', 'abd'), false);
    assert.equal(tokensEqual('abc', 'abcd'), false);
    assert.equal(tokensEqual('', ''), false, 'two empty tokens are not a match');
    assert.equal(tokensEqual(null, 'abc'), false);
    assert.equal(tokensEqual('abc', undefined), false);
});

test('parseCookies handles duplicates, quoting and bad escapes', () => {
    // parseCookies returns a null-prototype object on purpose (no __proto__ path);
    // compare by value rather than by prototype.
    assert.deepEqual({ ...parseCookies('a=1; b=2') }, { a: '1', b: '2' });
    assert.deepEqual({ ...parseCookies('a=1; a=2') }, { a: '2' }, 'later duplicate wins');
    assert.deepEqual({ ...parseCookies('x="quoted value"') }, { x: 'quoted value' });
    assert.deepEqual({ ...parseCookies('x=%E4%BD%A0%E5%A5%BD') }, { x: '你好' });
    assert.deepEqual({ ...parseCookies('x=%ZZ') }, { x: '%ZZ' }, 'an invalid escape is kept verbatim');
    assert.deepEqual({ ...parseCookies('') }, {});
    assert.deepEqual({ ...parseCookies('novalue') }, {}, 'a pair without = is skipped');
    assert.deepEqual(Object.keys(parseCookies('__proto__=x')), ['__proto__'], 'no prototype pollution');
});

test('serialiseCookie emits the security attributes', () => {
    const line = serialiseCookie('sid', 'abc', { maxAgeSeconds: 60, secure: true });
    assert.match(line, /^sid=abc/);
    assert.match(line, /Path=\//);
    assert.match(line, /Max-Age=60/);
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Lax/);
    assert.match(line, /Secure/);

    const insecure = serialiseCookie('sid', 'abc', {});
    assert.equal(insecure.includes('Secure'), false);
    assert.equal(insecure.includes('Max-Age'), false);

    const cleared = clearedCookie('sid', { secure: false });
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /^sid=;/, 'the value is emptied');
    assert.ok(cleared.startsWith('sid=;'), `expected an empty value first, got ${cleared}`);
    assert.equal(cleared.includes('Secure'), false);
});
