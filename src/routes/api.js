// SPDX-License-Identifier: GPL-3.0-or-later
// API routes.
//
// Response shape is uniform: `{ data: ... }` on success, `{ error: { message,
// code, details? } }` on failure. The browser client depends on that contract,
// and the API is documented in README.md so a script can use it too.
//
// The subject of this API is a MAPPING: one local UDP port that players connect to,
// forwarded to one upstream room server (`targetHost:targetPort`). There is no
// separate server entity; the pair lives on one row so the two halves cannot drift.

import { HttpError, readJsonBody, sendJson } from '../lib/http.js';
import { clearedCookie } from '../lib/tokens.js';
import {
    requireString, requirePort, requireName, requireHost, optionalPassword, optionalText,
    requireId, requireEnum, requireListenAddress,
} from '../lib/validate.js';
import { allocatePort, MAPPING_STATE } from '../lib/supervisor.js';
import { ABOUT } from '../lib/about.js';

const MAPPING_PROFILES = ['default', 'dual-host', 'legacy'];

/** Parse the stored extra_args JSON; a corrupt value degrades to an empty list. */
function parseExtraArgs(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || value === '') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Turn a stored mapping row into the JSON the browser consumes. */
export function mappingView(mapping, { supervisor = null } = {}) {
    const pid = supervisor ? supervisor.pidOf(mapping.id) : null;
    // The room's own numbers, as reported by the gateway's status line. `slots` is 0
    // until the gateway has joined and the room has answered; the UI says so rather
    // than inventing a capacity the operator never set.
    const stats = supervisor?.statsOf?.(mapping.id) ?? null;
    return {
        id: mapping.id,
        name: mapping.name,
        // The pair. localPort is what players dial; targetHost/targetPort is where
        // this console forwards them.
        localPort: mapping.local_port,
        targetHost: mapping.target_host,
        targetPort: mapping.target_port,
        listenAddress: mapping.listen_address,
        profile: mapping.profile,
        notes: mapping.notes ?? '',
        desiredState: mapping.desired_state,
        state: mapping.state,
        pid: pid ?? mapping.pid ?? null,
        failure: mapping.failure ?? '',
        startedAt: mapping.started_at ?? null,
        stoppedAt: mapping.stopped_at ?? null,
        createdAt: mapping.created_at,
        updatedAt: mapping.updated_at,
        // Live room occupancy: `roomSlots` is what the room says its capacity is,
        // `roomMembers` how many it currently lists. Both come from the gateway, not
        // from configuration.
        roomSlots: stats?.slots ?? 0,
        roomMembers: stats?.members ?? 0,
        roomStatsAt: stats?.at ?? null,
        // The upstream room password is never echoed back; the UI shows whether one
        // is set so the operator can tell "no password" from "a password is stored".
        hasPassword: Boolean(mapping.password),
        extraArgs: parseExtraArgs(mapping.extra_args),
    };
}

function userView(user) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at ?? null,
        disabled: Boolean(user.disabled),
        lockedUntil: user.locked_until ?? null,
    };
}

async function loadMappings(ds, supervisor) {
    const rows = await ds.listMappings();
    return rows.map((row) => mappingView(row, { supervisor }));
}

export function createApiRoutes({ router, auth, datasource, supervisor, config, logger }) {
    const ds = datasource;

    /**
     * Decide which local port a mapping gets.
     *
     * An explicit port is honoured and checked for conflicts; a blank one is taken
     * from the configured pool. The pool is only consulted for blanks -- a mapping's
     * port is never silently changed afterwards.
     */
    async function resolveLocalPort(requested, { excludeId = null } = {}) {
        const rows = await ds.listMappings();
        const used = new Set(
            rows.filter((row) => row.id !== excludeId).map((row) => row.local_port),
        );
        const raw = requested === undefined || requested === null ? '' : String(requested).trim();
        if (raw === '') {
            const allocated = allocatePort(config.gateways.localPortRange, used);
            if (!allocated) {
                const [low, high] = config.gateways.localPortRange;
                throw new HttpError(409,
                    `本地端口池 ${low}-${high} 已用尽，请扩大 gateways.localPortRange 或先删除不再使用的映射`,
                    { code: 'port_pool_exhausted' });
            }
            return allocated;
        }
        const port = requirePort(raw, '本地端口');
        if (used.has(port)) {
            throw new HttpError(409, `本地端口 ${port} 已被其它映射占用`, {
                code: 'port_in_use',
                details: { field: 'localPort', port },
            });
        }
        return port;
    }

    // ---- public ---------------------------------------------------------
    router.get('/api/health', { public: true }, async (req, res) => {
        await ds.ping();
        sendJson(res, 200, {
            data: {
                ok: true,
                uptimeSeconds: Math.round(process.uptime()),
                datasource: ds.driver,
                version: config.version ?? '0.1.0',
            },
        });
    });

    /**
     * Bootstrap state for the browser: whether setup is done, whether the caller
     * is signed in, and the CSRF token if so. One request on page load replaces a
     * round trip for every page.
     */
    /**
     * Build identity for the Settings > About card.
     *
     * Public on purpose: the operator who set the console up already has an account,
     * but a colleague who opens the URL before signing in should still be able to see
     * which build is deployed and where the source lives. Nothing here is secret.
     */
    router.get('/api/about', { public: true }, async (req, res) => {
        sendJson(res, 200, { data: ABOUT });
    });

    router.get('/api/session', { public: true }, async (req, res) => {
        const setupComplete = await auth.isSetupComplete();
        const context = setupComplete ? await auth.authenticate(req) : null;
        sendJson(res, 200, {
            data: {
                setupComplete,
                authenticated: Boolean(context),
                csrfToken: context?.csrfToken ?? null,
                user: context?.user ?? null,
                gatewayBinaryFound: Boolean(supervisor?.probeBinary()),
                gatewayBinaryError: supervisor?.binaryError ?? '',
            },
        });
    });

    router.post('/api/setup', { public: true }, async (req, res) => {
        const body = await readJsonBody(req);
        const result = await auth.completeSetup(
            { username: body.username, password: body.password, confirm: body.confirm },
            { remoteAddr: req.socket?.remoteAddress ?? '' },
        );
        sendJson(res, 201, { data: { username: result.username } });
    });

    router.post('/api/login', { public: true }, async (req, res) => {
        if (!(await auth.isSetupComplete())) {
            throw new HttpError(409, '请先完成管理员账户初始化', { code: 'setup_required' });
        }
        const body = await readJsonBody(req);
        const session = await auth.login(
            { username: body.username, password: body.password },
            { req, remoteAddr: req.socket?.remoteAddress ?? '' },
        );
        auth.setSessionCookie(req, res, session.token);
        sendJson(res, 200, {
            data: { user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt },
        });
    });

    router.post('/api/logout', { public: true }, async (req, res) => {
        const context = await auth.authenticate(req);
        if (context) {
            await auth.logout(req, res, context.sessionId);
        } else {
            res.setHeader('Set-Cookie', clearedCookie(auth.cookieName, auth.cookieOptions(req)));
        }
        sendJson(res, 200, { data: { ok: true } });
    });

    router.post('/api/password', async (req, res) => {
        const context = await auth.authenticate(req);
        auth.assertCsrf(req, context);
        const body = await readJsonBody(req);
        await auth.changePassword(context, {
            currentPassword: body.currentPassword,
            newPassword: body.newPassword,
            confirm: body.confirm,
        });
        // Every session was revoked, including this one: clear the cookie so the
        // browser drops to the login screen instead of looping on 401.
        res.setHeader('Set-Cookie', clearedCookie(auth.cookieName, auth.cookieOptions(req)));
        sendJson(res, 200, { data: { ok: true, reauthenticate: true } });
    });

    // ---- dashboard ------------------------------------------------------
    router.get('/api/dashboard', async (req, res, ctx) => {
        auth.assertRole(ctx, 'viewer');
        const mappings = await loadMappings(ds, supervisor);
        const events = await ds.listEvents({ limit: 30 });
        const counts = {
            total: mappings.length,
            running: mappings.filter((row) => row.state === MAPPING_STATE.running).length,
            failed: mappings.filter((row) => row.state === MAPPING_STATE.failed).length,
            stopped: mappings.filter((row) => row.state === MAPPING_STATE.stopped).length,
        };
        sendJson(res, 200, {
            data: {
                counts,
                mappings,
                events,
                localPortRange: config.gateways.localPortRange,
                gatewayBinaryFound: Boolean(supervisor?.probeBinary()),
                gatewayBinaryError: supervisor?.binaryError ?? '',
            },
        });
    });

    // ---- mappings -------------------------------------------------------
    router.get('/api/mappings', async (req, res, ctx) => {
        auth.assertRole(ctx, 'viewer');
        sendJson(res, 200, { data: await loadMappings(ds, supervisor) });
    });

    router.post('/api/mappings', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const body = await readJsonBody(req);

        const localPort = await resolveLocalPort(body.localPort);
        const targetHost = requireHost(body.targetHost, '目标服务器地址');
        const targetPort = requirePort(body.targetPort, '目标服务器端口');
        const name = body.name === undefined || String(body.name).trim() === ''
            // A mapping without a name is named after its pair, which is what an
            // operator would call it anyway.
            ? `端口${localPort}`
            : requireName(body.name, '名称', { max: 64 });
        if (await ds.findMappingByName(name)) {
            throw new HttpError(409, '已存在同名映射', { code: 'duplicate_name', details: { field: 'name' } });
        }
        const password = optionalPassword(body.password);
        const listenAddress = body.listenAddress === undefined
            ? '0.0.0.0'
            : requireListenAddress(body.listenAddress, '监听地址');
        const profile = requireEnum(body.profile ?? 'default', '配置档', MAPPING_PROFILES);
        const notes = optionalText(body.notes, '备注', { max: 500 });

        // No capacity field: the gateway learns the room's real member_slots once it
        // has joined, so there is nothing for an operator to type.
        const id = await ds.createMapping({
            name, localPort, targetHost, targetPort, password, listenAddress, profile, notes,
        });
        await ds.addEvent({
            mappingId: id,
            kind: 'mapping.created',
            detail: `本地 ${localPort} → ${targetHost}:${targetPort}`,
            actor: ctx.user.username,
        });
        const row = await ds.findMappingById(id);
        sendJson(res, 201, { data: mappingView(row, { supervisor }) });
    });

    router.patch('/api/mappings/:id', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const row = await ds.findMappingById(id);
        if (!row) throw new HttpError(404, '映射不存在', { code: 'not_found' });

        const body = await readJsonBody(req);
        const fields = {};

        if (body.name !== undefined) {
            const name = requireName(body.name, '名称', { max: 64 });
            const existing = await ds.findMappingByName(name);
            if (existing && existing.id !== id) {
                throw new HttpError(409, '已存在同名映射', { code: 'duplicate_name', details: { field: 'name' } });
            }
            fields.name = name;
        }
        if (body.localPort !== undefined) {
            fields.local_port = await resolveLocalPort(body.localPort, { excludeId: id });
        }
        if (body.targetHost !== undefined) fields.target_host = requireHost(body.targetHost, '目标服务器地址');
        if (body.targetPort !== undefined) fields.target_port = requirePort(body.targetPort, '目标服务器端口');
        if (body.password !== undefined) fields.password = optionalPassword(body.password);
        if (body.listenAddress !== undefined) {
            fields.listen_address = requireListenAddress(body.listenAddress, '监听地址');
        }
        if (body.profile !== undefined) fields.profile = requireEnum(body.profile, '配置档', MAPPING_PROFILES);
        if (body.notes !== undefined) fields.notes = optionalText(body.notes, '备注', { max: 500 });

        // A running process already has its command line; changing what it dials or
        // where it listens cannot take effect until it is restarted, so say that
        // instead of silently applying half of it.
        //
        // "Running" is judged from BOTH the live process and the stored state: a
        // mapping whose process just died is still recorded as running, and applying
        // a port change there would be just as misleading.
        const restartFields = ['local_port', 'target_host', 'target_port', 'password', 'listen_address', 'profile'];
        const running = (supervisor?.isRunning(id) ?? false)
            || row.state === MAPPING_STATE.running
            || row.state === MAPPING_STATE.starting
            || row.desired_state === 'running';
        if (running && restartFields.some((key) => key in fields)) {
            throw new HttpError(409, '该映射正在运行，端口/目标/密码/配置档的改动需要先停止映射', {
                code: 'mapping_running',
                details: { fields: restartFields.filter((key) => key in fields) },
            });
        }

        if (Object.keys(fields).length > 0) {
            await ds.updateMapping(id, fields);
            await ds.addEvent({
                mappingId: id,
                kind: 'mapping.updated',
                detail: Object.keys(fields).join(', '),
                actor: ctx.user.username,
            });
        }
        const updated = await ds.findMappingById(id);
        sendJson(res, 200, { data: mappingView(updated, { supervisor }) });
    });

    router.delete('/api/mappings/:id', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const row = await ds.findMappingById(id);
        if (!row) throw new HttpError(404, '映射不存在', { code: 'not_found' });
        // Deleting a running mapping would orphan its process while losing the record
        // needed to stop it. Judged from both the live process and the stored state,
        // so a mapping whose process just died is still covered.
        const running = (supervisor?.isRunning(id) ?? false)
            || row.state === MAPPING_STATE.running
            || row.state === MAPPING_STATE.starting
            || row.desired_state === 'running';
        if (running) {
            throw new HttpError(409, '该映射正在运行，请先停止再删除', { code: 'mapping_running' });
        }
        await ds.deleteMapping(id);
        await ds.addEvent({
            kind: 'mapping.deleted',
            detail: `${row.name}（本地 ${row.local_port} → ${row.target_host}:${row.target_port}）`,
            actor: ctx.user.username,
        });
        sendJson(res, 200, { data: { ok: true, id } });
    });

    // Batch is registered before the :id patterns so the literal `batch` segment is
    // never captured as a mapping id.
    /**
     * Batch start/stop. Per-mapping results are always returned, including partial
     * success, so the operator can see exactly which one refused and why.
     */
    router.post('/api/mappings/batch/:action', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const action = requireEnum(ctx.params.action, '操作', ['start', 'stop']);
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : null;
        if (!ids || ids.length === 0) {
            throw new HttpError(400, '请至少选择一个映射', { code: 'invalid_field', details: { field: 'ids' } });
        }
        if (ids.length > 200) {
            throw new HttpError(400, '一次最多操作 200 个映射', { code: 'invalid_field', details: { field: 'ids' } });
        }
        const results = [];
        for (const raw of ids) {
            const id = requireId(raw, 'ids');
            const row = await ds.findMappingById(id);
            if (!row) {
                results.push({ id, ok: false, error: '映射不存在' });
                continue;
            }
            try {
                if (action === 'start') {
                    const result = await supervisor.startMapping(id, { actor: ctx.user.username });
                    results.push({ id, name: row.name, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
                } else {
                    await supervisor.stopMapping(id, { actor: ctx.user.username });
                    results.push({ id, name: row.name, ok: true });
                }
            } catch (error) {
                results.push({ id, name: row.name, ok: false, error: error.message });
            }
        }
        await ds.addEvent({
            kind: `mapping.batch.${action}`,
            detail: `批量${action === 'start' ? '启动' : '停止'} ${results.filter((item) => item.ok).length}/${results.length} 个映射`,
            actor: ctx.user.username,
        });
        sendJson(res, 200, {
            data: {
                action,
                results,
                succeeded: results.filter((item) => item.ok).length,
                failed: results.filter((item) => !item.ok).length,
            },
        });
    });

    router.post('/api/mappings/:id/start', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const result = await supervisor.startMapping(id, { actor: ctx.user.username });
        const row = await ds.findMappingById(id);
        sendJson(res, result.ok ? 200 : 409, {
            data: row ? mappingView(row, { supervisor }) : null,
            ...(result.ok ? {} : { error: { message: result.error, code: 'start_failed' } }),
        });
    });

    router.post('/api/mappings/:id/stop', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const row = await ds.findMappingById(id);
        if (!row) throw new HttpError(404, '映射不存在', { code: 'not_found' });
        await supervisor.stopMapping(id, { actor: ctx.user.username });
        const updated = await ds.findMappingById(id);
        sendJson(res, 200, { data: mappingView(updated, { supervisor }) });
    });

    router.get('/api/mappings/:id/log', async (req, res, ctx) => {
        auth.assertRole(ctx, 'viewer');
        const id = requireId(ctx.params.id);
        const row = await ds.findMappingById(id);
        if (!row) throw new HttpError(404, '映射不存在', { code: 'not_found' });
        const lines = Math.min(Math.max(Number(req.query?.lines ?? 200) || 200, 1), 2000);
        const log = supervisor.readLog(id, { lines });
        sendJson(res, 200, { data: log });
    });

    // ---- users ----------------------------------------------------------
    router.get('/api/users', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const users = await ds.listUsers();
        sendJson(res, 200, { data: users.map(userView) });
    });

    router.post('/api/users', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const body = await readJsonBody(req);
        const created = await auth.createAccount({
            username: body.username,
            password: body.password,
            role: requireEnum(body.role ?? 'admin', '角色', ['admin', 'viewer']),
        });
        await ds.addEvent({
            kind: 'user.created',
            detail: `新增账户 ${created.username} (${created.role})`,
            actor: ctx.user.username,
        });
        sendJson(res, 201, { data: userView(created) });
    });

    router.delete('/api/users/:id', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        if (id === ctx.user.id) {
            throw new HttpError(400, '不能删除自己的账户', { code: 'self_delete' });
        }
        const target = await ds.findUserById(id);
        if (!target) throw new HttpError(404, '账户不存在', { code: 'not_found' });
        // The owner is the account that can never be locked out of the console.
        if (target.role === 'owner') {
            throw new HttpError(403, '拥有者账户不可删除', { code: 'owner_protected' });
        }
        await ds.deleteUser(id);
        await ds.addEvent({
            kind: 'user.deleted',
            detail: `删除账户 ${target.username}`,
            actor: ctx.user.username,
        });
        sendJson(res, 200, { data: { ok: true, id } });
    });

    // ---- events ---------------------------------------------------------
    router.get('/api/events', async (req, res, ctx) => {
        auth.assertRole(ctx, 'viewer');
        const limit = Math.min(Math.max(Number(req.query?.limit ?? 100) || 100, 1), 500);
        const mappingId = req.query?.mappingId ? requireId(req.query.mappingId, 'mappingId') : null;
        const events = await ds.listEvents({ mappingId, limit });
        sendJson(res, 200, { data: events });
    });

    // ---- diagnostics ----------------------------------------------------
    router.get('/api/diagnostics', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const rows = await ds.listMappings();
        const binary = supervisor?.probeBinary();
        sendJson(res, 200, {
            data: {
                datasource: ds.driver,
                sqlitePath: config.storage.driver === 'sqlite' ? config.storage.sqlite.path : null,
                configPath: config.configPath ?? '',
                localPortRange: config.gateways.localPortRange,
                runtimeDir: config.gateways.runtimeDir,
                usedLocalPorts: rows.map((row) => row.local_port).sort((a, b) => a - b),
                mappingCount: rows.length,
                gatewayBinaryPath: binary,
                gatewayBinaryError: binary ? '' : (supervisor?.binaryError ?? ''),
                gatewayInterpreter: config.gateways.interpreter,
                nodeVersion: process.version,
                platform: process.platform,
                uptimeSeconds: Math.round(process.uptime()),
            },
        });
    });
}
