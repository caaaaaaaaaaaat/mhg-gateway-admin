// SPDX-License-Identifier: GPL-3.0-or-later
// Authentication: first-run setup, login, logout, session validation, CSRF.
//
// Threat model this file is written against:
//   * An unauthenticated attacker on the internet reaching the console.
//   * A leaked database (session ids are stored hashed, passwords scrypt-hashed).
//   * Cross-site request forgery from a page the operator visits.
//   * Credential stuffing (per-account failure counter + lockout).
// It does NOT defend against an attacker who already has OS-level access to the
// server, and it does not implement multi-factor authentication.

import { HttpError } from './http.js';
import {
    hashPassword, verifyPassword, checkPasswordStrength,
} from './password.js';
import {
    randomToken, hashToken, tokensEqual, parseCookies, serialiseCookie, clearedCookie,
    CSRF_TOKEN_BYTES,
} from './tokens.js';

export const SETUP_KEY = 'setup.completed';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Route handlers receive a `routeContext` that spreads the session context and
 * adds `params`. Helpers must accept either shape, otherwise `auth.assertRole(ctx)`
 * would silently see `ctx.user` (present) but `ctx.csrfToken` (absent).
 */
function unwrapContext(value) {
    if (!value) return null;
    if (value.sessionId !== undefined && value.user !== undefined) return value;
    if (value.context) return value.context;
    return null;
}

/** Roles, ordered by capability. `owner` can never be removed by an admin. */
export const ROLES = Object.freeze({ owner: 3, admin: 2, viewer: 1 });

export function roleAtLeast(role, required) {
    return (ROLES[role] ?? 0) >= (ROLES[required] ?? Infinity);
}

/**
 * Owns the auth state that is not per-request: the cookie policy and the
 * derived "is this deployment behind TLS" decision.
 */
export class AuthService {
    constructor({ config, datasource, logger, now = () => Date.now() }) {
        this.config = config;
        this.ds = datasource;
        this.logger = logger;
        this.now = now;
    }

    get cookieName() {
        return this.config.auth.cookieName;
    }

    /**
     * Resolve the Secure cookie flag. 'auto' means "Secure when the request looks
     * like HTTPS", which keeps `http://localhost` usable for a first run while
     * still protecting a real deployment. An explicit true/false wins.
     */
    useSecureCookie(req) {
        const setting = this.config.auth.secureCookies;
        if (setting === true) return true;
        if (setting === false) return false;
        if (this.config.server.publicUrl.startsWith('https://')) return true;
        if (this.config.server.trustProxy) {
            const forwarded = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
            if (forwarded === 'https') return true;
        }
        return Boolean(req.socket?.encrypted);
    }

    cookieOptions(req, { maxAgeSeconds } = {}) {
        return {
            path: '/',
            httpOnly: true,
            sameSite: 'Lax',
            secure: this.useSecureCookie(req),
            maxAgeSeconds,
        };
    }

    /** True when an administrator account exists. */
    async isSetupComplete() {
        return (await this.ds.countUsers()) > 0;
    }

    /**
     * Create the first administrator. Only callable while no user exists, which
     * makes the setup endpoint safe to leave reachable: after the first success it
     * returns 409 forever.
     */
    async completeSetup({ username, password, confirm }, { remoteAddr, actor = 'setup' } = {}) {
        if (await this.isSetupComplete()) {
            throw new HttpError(409, '管理员账户已存在，无法再次初始化', { code: 'setup_done' });
        }
        const name = validateUsername(username);
        if (confirm !== undefined && password !== confirm) {
            throw new HttpError(400, '两次输入的密码不一致', { code: 'password_mismatch' });
        }
        const strength = checkPasswordStrength(password, {
            minLength: this.config.auth.passwordMinLength,
        });
        if (!strength.ok) {
            throw new HttpError(400, strength.reason, { code: 'weak_password' });
        }
        // Check again right before the write: two simultaneous setup posts would
        // otherwise both pass the early check on some datasources.
        if (await this.ds.countUsers() > 0) {
            throw new HttpError(409, '管理员账户已存在，无法再次初始化', { code: 'setup_done' });
        }
        const passwordHash = await hashPassword(password);
        const userId = await this.ds.createUser({ username: name, passwordHash, role: 'owner' });
        await this.ds.setSetting(SETUP_KEY, new Date(this.now()).toISOString());
        await this.ds.addEvent({
            kind: 'auth.setup',
            detail: `管理员 ${name} 已创建`,
            actor,
        });
        this.logger.info('first-run setup completed', { username: name, userId, remoteAddr });
        return { userId, username: name };
    }

    /**
     * Verify credentials and issue a session.
     * Returns { token, csrfToken, expiresAt, user } on success.
     *
     * The failure path deliberately does not distinguish "no such user" from
     * "wrong password" in the response, but does keep them distinct in the log
     * (that difference is what an operator needs to diagnose).
     */
    async login({ username, password }, { req, remoteAddr }) {
        const name = typeof username === 'string' ? username.trim() : '';
        if (!name || typeof password !== 'string' || password === '') {
            throw new HttpError(400, '请输入用户名和密码', { code: 'credentials_required' });
        }
        const user = await this.ds.findUserByUsername(name);
        const now = this.now();

        if (!user) {
            this.logger.warn('login for unknown user', { username: name, remoteAddr });
            // Burn comparable time so the response latency does not reveal whether
            // the account exists.
            await verifyPassword(password, await hashPassword(randomToken(8)));
            throw new HttpError(401, '用户名或密码不正确', { code: 'invalid_credentials' });
        }
        if (user.disabled) {
            this.logger.warn('login for disabled user', { username: name, remoteAddr });
            throw new HttpError(401, '用户名或密码不正确', { code: 'invalid_credentials' });
        }
        if (user.locked_until && Number(user.locked_until) > now) {
            const minutes = Math.ceil((Number(user.locked_until) - now) / 60_000);
            throw new HttpError(423, `登录失败次数过多，请在 ${minutes} 分钟后再试`, { code: 'account_locked' });
        }
        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) {
            const failed = Number(user.failed_logins ?? 0) + 1;
            const lock = failed >= this.config.auth.maxFailedLogins;
            await this.ds.recordLoginFailure(user.id, {
                failedLogins: failed,
                lockedUntil: lock ? now + this.config.auth.lockoutMinutes * 60_000 : null,
            });
            this.logger.warn('login failed', {
                username: name, remoteAddr, failed, locked: lock,
            });
            if (lock) {
                throw new HttpError(423, `登录失败次数过多，请在 ${this.config.auth.lockoutMinutes} 分钟后再试`, {
                    code: 'account_locked',
                });
            }
            throw new HttpError(401, '用户名或密码不正确', { code: 'invalid_credentials' });
        }

        await this.ds.recordLoginSuccess(user.id, now);
        const token = randomToken();
        const csrfToken = randomToken(CSRF_TOKEN_BYTES);
        const expiresAt = now + this.config.auth.sessionTtlHours * 3_600_000;
        await this.ds.createSession({
            tokenHash: hashToken(token),
            userId: user.id,
            csrfToken,
            expiresAt,
            userAgent: String(req.headers['user-agent'] ?? '').slice(0, 255),
            remoteAddr: remoteAddr ?? '',
        });
        this.logger.info('login succeeded', { username: user.username, remoteAddr });
        return { token, csrfToken, expiresAt, user: { id: user.id, username: user.username, role: user.role } };
    }

    /**
     * Resolve the caller from the session cookie. Returns null when absent,
     * expired or revoked. Extends the sliding expiry within an absolute cap.
     */
    async authenticate(req) {
        const cookies = parseCookies(req.headers.cookie ?? '');
        const raw = cookies[this.cookieName];
        if (!raw) return null;
        const session = await this.ds.findSessionByTokenHash(hashToken(raw));
        if (!session) return null;
        const now = this.now();
        if (Number(session.expires_at) <= now) {
            await this.ds.deleteSession(session.id);
            return null;
        }
        const user = await this.ds.findUserById(session.user_id);
        if (!user || user.disabled) {
            await this.ds.deleteSession(session.id);
            return null;
        }
        // Sliding expiry, capped so a stolen cookie cannot live forever.
        const absoluteCap = Number(session.created_at) + this.config.auth.sessionMaxDays * 86_400_000;
        const extended = Math.min(now + this.config.auth.sessionTtlHours * 3_600_000, absoluteCap);
        if (extended > Number(session.expires_at) + 30_000) {
            await this.ds.touchSession(session.id, { lastSeenAt: now, expiresAt: extended });
        }
        return {
            sessionId: session.id,
            csrfToken: session.csrf_token,
            user: { id: user.id, username: user.username, role: user.role },
        };
    }

    /** Invalidate the caller's session and clear the cookie. */
    async logout(req, res, sessionId) {
        if (sessionId) await this.ds.deleteSession(sessionId);
        res.setHeader('Set-Cookie', clearedCookie(this.cookieName, this.cookieOptions(req)));
    }

    /** Build the Set-Cookie header for a fresh session. */
    setSessionCookie(req, res, token) {
        res.setHeader('Set-Cookie', serialiseCookie(this.cookieName, token, this.cookieOptions(req, {
            maxAgeSeconds: this.config.auth.sessionTtlHours * 3600,
        })));
    }

    /**
     * CSRF check for state-changing requests.
     * Requires the header, so a cross-site form post (which cannot set headers)
     * and a naive cross-site fetch both fail. Double-submit against the session
     * row means no separate token store is needed.
     *
     * A missing session is 401 (log in first); a present session with a wrong or
     * missing token is 403 (the request was forged or the page is stale).
     */
    assertCsrf(req, contextOrRouteContext) {
        const context = unwrapContext(contextOrRouteContext);
        if (!context) throw new HttpError(401, '请先登录', { code: 'unauthenticated' });
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
        const provided = req.headers[CSRF_HEADER];
        if (typeof provided !== 'string' || provided === '' || !tokensEqual(provided, context.csrfToken)) {
            throw new HttpError(403, 'CSRF 校验失败，请刷新页面后重试', { code: 'csrf_failed' });
        }
    }

    /** Require at least the given role, else 403. */
    assertRole(contextOrRouteContext, required) {
        const context = unwrapContext(contextOrRouteContext);
        if (!context) throw new HttpError(401, '请先登录', { code: 'unauthenticated' });
        if (!roleAtLeast(context.user?.role, required)) {
            throw new HttpError(403, '当前账户无权执行此操作', { code: 'forbidden' });
        }
        return context;
    }

    /** Change the caller's own password and revoke every other session. */
    async changePassword(context, { currentPassword, newPassword, confirm }) {
        if (!context) throw new HttpError(401, '请先登录', { code: 'unauthenticated' });
        const user = await this.ds.findUserById(context.user.id);
        if (!user) throw new HttpError(401, '请先登录', { code: 'unauthenticated' });
        const ok = await verifyPassword(currentPassword, user.password_hash);
        if (!ok) throw new HttpError(403, '当前密码不正确', { code: 'wrong_current_password' });
        if (newPassword !== confirm) {
            throw new HttpError(400, '两次输入的新密码不一致', { code: 'password_mismatch' });
        }
        const strength = checkPasswordStrength(newPassword, {
            minLength: this.config.auth.passwordMinLength,
        });
        if (!strength.ok) throw new HttpError(400, strength.reason, { code: 'weak_password' });
        if (newPassword === currentPassword) {
            throw new HttpError(400, '新密码不能与当前密码相同', { code: 'password_unchanged' });
        }
        await this.ds.updateUserPassword(user.id, await hashPassword(newPassword));
        await this.ds.deleteSessionsForUser(user.id);
        await this.ds.addEvent({
            kind: 'auth.password_changed',
            detail: `用户 ${user.username} 修改了密码`,
            actor: user.username,
        });
        this.logger.info('password changed', { username: user.username });
    }
}

/**
 * Username rules: 3-32 characters, letters/digits/underscore/dot/dash, must start
 * with a letter or digit. Deliberately ASCII so an operator can always type it.
 */
export function validateUsername(value) {
    if (typeof value !== 'string') throw new HttpError(400, '用户名必须是字符串', { code: 'invalid_username' });
    const name = value.trim();
    if (name.length < 3 || name.length > 32) {
        throw new HttpError(400, '用户名长度需要 3-32 个字符', { code: 'invalid_username' });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
        throw new HttpError(400, '用户名只能包含字母、数字、下划线、点和短横线，且以字母或数字开头', {
            code: 'invalid_username',
        });
    }
    return name;
}
