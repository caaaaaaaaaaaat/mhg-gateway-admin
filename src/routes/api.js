// SPDX-License-Identifier: GPL-3.0-or-later
// API routes.
//
// Response shape is uniform: `{ data: ... }` on success, `{ error: { message,
// code, details? } }` on failure. The browser client depends on that contract,
// and the API is documented in README.md so a script can use it too.

import { HttpError, readJsonBody, sendJson } from '../lib/http.js';
import { clearedCookie } from '../lib/tokens.js';
import {
    requireString, requirePort, requireName, requireHost, optionalPassword, optionalText,
    requireId, requireEnum, requireListenAddress,
} from '../lib/validate.js';
import { allocatePort, ROOM_STATE } from '../lib/supervisor.js';

const ROOM_PROFILES = ['default', 'dual-host', 'legacy'];

/** Turn a stored room row into the JSON the browser consumes. */
export function roomView(room, { server = null, supervisor = null } = {}) {
    const pid = supervisor ? supervisor.pidOf(room.id) : null;
    return {
        id: room.id,
        name: room.name,
        serverId: room.server_id ?? null,
        serverName: server?.name ?? null,
        serverHost: server?.host ?? null,
        serverPort: server?.port ?? null,
        citraPort: room.citra_port,
        roomPort: room.room_port,
        listenAddress: room.listen_address,
        profile: room.profile,
        desiredState: room.desired_state,
        state: room.state,
        pid: pid ?? room.pid ?? null,
        failure: room.failure ?? '',
        startedAt: room.started_at ?? null,
        stoppedAt: room.stopped_at ?? null,
        createdAt: room.created_at,
        updatedAt: room.updated_at,
        // Password is never echoed back; the UI shows whether one is set.
        hasPassword: Boolean(room.password),
        extraArgs: Array.isArray(room.extra_args) ? room.extra_args : [],
    };
}

function serverView(server) {
    return {
        id: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        notes: server.notes ?? '',
        hasPassword: Boolean(server.password),
        createdAt: server.created_at,
        updatedAt: server.updated_at,
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

/** Room data plus the server it points at, for one call. */
async function loadRooms(ds, supervisor) {
    const rooms = await ds.listRooms();
    const servers = await ds.listServers();
    const byId = new Map(servers.map((server) => [server.id, server]));
    return rooms.map((room) => roomView(room, {
        server: byId.get(room.server_id) ?? null,
        supervisor,
    }));
}

export function createApiRoutes({ router, auth, datasource, supervisor, config, logger }) {
    const ds = datasource;

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
        const rooms = await loadRooms(ds, supervisor);
        const servers = await ds.listServers();
        const events = await ds.listEvents({ limit: 30 });
        const counts = {
            total: rooms.length,
            running: rooms.filter((room) => room.state === ROOM_STATE.running).length,
            failed: rooms.filter((room) => room.state === ROOM_STATE.failed).length,
            stopped: rooms.filter((room) => room.state === ROOM_STATE.stopped).length,
        };
        sendJson(res, 200, {
            data: {
                counts,
                rooms,
                servers: servers.map(serverView),
                events,
                gatewayBinaryFound: Boolean(supervisor?.probeBinary()),
                gatewayBinaryError: supervisor?.binaryError ?? '',
            },
        });
    });

    // ---- servers --------------------------------------------------------
    router.get('/api/servers', async (req, res, ctx) => {
        auth.assertRole(ctx, 'viewer');
        const servers = await ds.listServers();
        sendJson(res, 200, { data: servers.map(serverView) });
    });

    router.post('/api/servers', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const body = await readJsonBody(req);
        const name = requireName(body.name, '名称', { max: 64 });
        if (await ds.listServers().then((list) => list.some((item) => item.name === name))) {
            throw new HttpError(409, '已存在同名的房间服务器', { code: 'duplicate_name' });
        }
        const host = requireHost(body.host, '地址');
        const port = requirePort(body.port, '端口');
        const password = optionalPassword(body.password, '房间密码');
        const notes = optionalText(body.notes, '备注');
        const id = await ds.createServer({ name, host, port, password, notes });
        await ds.addEvent({ kind: 'server.created', detail: `新增服务器 ${name} (${host}:${port})`, actor: ctx.user.username });
        sendJson(res, 201, { data: serverView(await ds.findServerById(id)) });
    });

    router.patch('/api/servers/:id', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const existing = await ds.findServerById(id);
        if (!existing) throw new HttpError(404, '房间服务器不存在', { code: 'not_found' });
        const body = await readJsonBody(req);
        const fields = {};
        if (body.name !== undefined) fields.name = requireName(body.name, '名称', { max: 64 });
        if (body.host !== undefined) fields.host = requireHost(body.host, '地址');
        if (body.port !== undefined) fields.port = requirePort(body.port, '端口');
        if (body.password !== undefined) fields.password = optionalPassword(body.password, '房间密码');
        if (body.notes !== undefined) fields.notes = optionalText(body.notes, '备注');
        if (fields.name && fields.name !== existing.name) {
            const clash = (await ds.listServers()).some((item) => item.name === fields.name && item.id !== id);
            if (clash) throw new HttpError(409, '已存在同名的房间服务器', { code: 'duplicate_name' });
        }
        await ds.updateServer(id, fields);
        await ds.addEvent({ kind: 'server.updated', detail: `更新服务器 #${id}`, actor: ctx.user.username });
        sendJson(res, 200, { data: serverView(await ds.findServerById(id)) });
    });

    router.delete('/api/servers/:id', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const existing = await ds.findServerById(id);
        if (!existing) throw new HttpError(404, '房间服务器不存在', { code: 'not_found' });
        const inUse = (await ds.listRooms()).filter((room) => room.server_id === id);
        if (inUse.length > 0) {
            throw new HttpError(409, `还有 ${inUse.length} 个房间绑定在这台服务器上，请先修改它们`, {
                code: 'server_in_use',
                details: { rooms: inUse.map((room) => room.name) },
            });
        }
        await ds.deleteServer(id);
        await ds.addEvent({ kind: 'server.deleted', detail: `删除服务器 ${existing.name}`, actor: ctx.user.username });
        sendJson(res, 200, { data: { ok: true } });
    });

    // ---- rooms ----------------------------------------------------------
    router.get('/api/rooms', async (req, res, ctx) => {
        auth.assertRole(ctx, 'viewer');
        sendJson(res, 200, { data: await loadRooms(ds, supervisor) });
    });

    router.post('/api/rooms', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const body = await readJsonBody(req);
        const name = requireName(body.name, '房间名', { max: 32 });
        if (await ds.findRoomByName(name)) {
            throw new HttpError(409, '已存在同名的房间', { code: 'duplicate_name' });
        }
        const serverId = requireId(body.serverId, '房间服务器');
        const server = await ds.findServerById(serverId);
        if (!server) throw new HttpError(400, '所选房间服务器不存在', { code: 'invalid_field', details: { field: 'serverId' } });

        const profile = requireEnum(body.profile ?? 'default', '配置档', ROOM_PROFILES);
        const listenAddress = requireListenAddress(body.listenAddress ?? '0.0.0.0');
        const password = optionalPassword(body.password, 'Citra 接入密码');
        const used = await ds.listUsedPorts();

        let citraPort;
        let roomPort;
        if (body.citraPort !== undefined && body.citraPort !== null && body.citraPort !== '') {
            citraPort = requirePort(body.citraPort, 'Citra 接入端口');
            if (used.citra.has(citraPort)) {
                throw new HttpError(409, `Citra 接入端口 ${citraPort} 已被其他房间占用`, {
                    code: 'port_in_use',
                    details: { field: 'citraPort' },
                });
            }
        } else {
            citraPort = allocatePort(config.gateways.citraPortRange, used.citra);
            if (citraPort === null) {
                throw new HttpError(409, 'Citra 端口池已用尽，请调整 gateways.citraPortRange', { code: 'port_pool_exhausted' });
            }
        }
        if (body.roomPort !== undefined && body.roomPort !== null && body.roomPort !== '') {
            roomPort = requirePort(body.roomPort, '房间服务器端口');
            if (used.room.has(roomPort)) {
                throw new HttpError(409, `房间服务器端口 ${roomPort} 已被其他房间占用`, {
                    code: 'port_in_use',
                    details: { field: 'roomPort' },
                });
            }
        } else {
            roomPort = allocatePort(config.gateways.roomPortRange, used.room);
            if (roomPort === null) {
                throw new HttpError(409, '房间端口池已用尽，请调整 gateways.roomPortRange', { code: 'port_pool_exhausted' });
            }
        }

        const id = await ds.createRoom({
            name,
            serverId,
            citraPort,
            roomPort,
            listenAddress,
            password,
            profile,
            desiredState: 'stopped',
        });
        await ds.addEvent({
            kind: 'room.created',
            detail: `新增房间 ${name}（Citra ${citraPort} → ${server.host}:${roomPort}）`,
            actor: ctx.user.username,
            roomId: id,
        });
        const created = await ds.findRoomById(id);
        sendJson(res, 201, { data: roomView(created, { server, supervisor }) });
    });

    router.patch('/api/rooms/:id', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const existing = await ds.findRoomById(id);
        if (!existing) throw new HttpError(404, '房间不存在', { code: 'not_found' });
        const body = await readJsonBody(req);
        const fields = {};
        if (body.name !== undefined) {
            const name = requireName(body.name, '房间名', { max: 32 });
            const clash = await ds.findRoomByName(name);
            if (clash && clash.id !== id) throw new HttpError(409, '已存在同名的房间', { code: 'duplicate_name' });
            fields.name = name;
        }
        if (body.serverId !== undefined) {
            const serverId = requireId(body.serverId, '房间服务器');
            const server = await ds.findServerById(serverId);
            if (!server) throw new HttpError(400, '所选房间服务器不存在', { code: 'invalid_field', details: { field: 'serverId' } });
            fields.server_id = serverId;
        }
        if (body.profile !== undefined) fields.profile = requireEnum(body.profile, '配置档', ROOM_PROFILES);
        if (body.listenAddress !== undefined) fields.listen_address = requireListenAddress(body.listenAddress);
        if (body.password !== undefined) fields.password = optionalPassword(body.password, 'Citra 接入密码');
        const used = await ds.listUsedPorts();
        if (body.citraPort !== undefined && body.citraPort !== null) {
            const port = requirePort(body.citraPort, 'Citra 接入端口');
            used.citra.delete(existing.citra_port);
            if (used.citra.has(port)) {
                throw new HttpError(409, `Citra 接入端口 ${port} 已被其他房间占用`, {
                    code: 'port_in_use',
                    details: { field: 'citraPort' },
                });
            }
            fields.citra_port = port;
        }
        if (body.roomPort !== undefined && body.roomPort !== null) {
            const port = requirePort(body.roomPort, '房间服务器端口');
            used.room.delete(existing.room_port);
            if (used.room.has(port)) {
                throw new HttpError(409, `房间服务器端口 ${port} 已被其他房间占用`, {
                    code: 'port_in_use',
                    details: { field: 'roomPort' },
                });
            }
            fields.room_port = port;
        }
        // Changing listen/port/password for a live room would leave the running
        // process with the old settings, which reads as a bug. Require a stop first.
        const restartRequired = ['listen_address', 'citra_port', 'room_port', 'password', 'profile', 'server_id']
            .some((key) => fields[key] !== undefined && fields[key] !== existing[key]);
        if (restartRequired && existing.state === ROOM_STATE.running) {
            throw new HttpError(409, '房间正在运行，请先停止再修改这些设置', { code: 'room_running' });
        }
        await ds.updateRoom(id, fields);
        await ds.addEvent({ kind: 'room.updated', detail: `更新房间 #${id}`, actor: ctx.user.username, roomId: id });
        const updated = await ds.findRoomById(id);
        const server = updated.server_id ? await ds.findServerById(updated.server_id) : null;
        sendJson(res, 200, { data: roomView(updated, { server, supervisor }) });
    });

    router.delete('/api/rooms/:id', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const existing = await ds.findRoomById(id);
        if (!existing) throw new HttpError(404, '房间不存在', { code: 'not_found' });
        if (supervisor?.isRunning(id)) {
            await supervisor.stopRoom(id, { actor: ctx.user.username, reason: 'room-deleted' });
        }
        await ds.deleteRoom(id);
        await ds.addEvent({ kind: 'room.deleted', detail: `删除房间 ${existing.name}`, actor: ctx.user.username });
        sendJson(res, 200, { data: { ok: true } });
    });

    // Single-room start/stop, plus the batch endpoints the console is built for.
    // NOTE: batch/:action is registered before rooms/:id/* so the literal `batch`
    // segment is never captured as a room id by the :id pattern.
    /**
     * Batch start/stop. Per-room results are always returned, including partial
     * success, so the operator can see exactly which room refused and why.
     */
    router.post('/api/rooms/batch/:action', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const action = requireEnum(ctx.params.action, '操作', ['start', 'stop']);
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : null;
        if (!ids || ids.length === 0) {
            throw new HttpError(400, '请至少选择一个房间', { code: 'invalid_field', details: { field: 'ids' } });
        }
        if (ids.length > 200) {
            throw new HttpError(400, '一次最多操作 200 个房间', { code: 'invalid_field', details: { field: 'ids' } });
        }
        const targets = [];
        for (const raw of ids) {
            const id = requireId(raw, 'ids');
            const room = await ds.findRoomById(id);
            if (!room) {
                targets.push({ id, ok: false, error: '房间不存在' });
                continue;
            }
            try {
                if (action === 'start') {
                    const result = await supervisor.startRoom(id, { actor: ctx.user.username });
                    targets.push({ id, name: room.name, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
                } else {
                    await supervisor.stopRoom(id, { actor: ctx.user.username });
                    targets.push({ id, name: room.name, ok: true });
                }
            } catch (error) {
                targets.push({ id, name: room.name, ok: false, error: error.message });
            }
        }
        await ds.addEvent({
            kind: `room.batch.${action}`,
            detail: `批量${action === 'start' ? '启动' : '停止'} ${targets.filter((t) => t.ok).length}/${targets.length} 个房间`,
            actor: ctx.user.username,
        });
        sendJson(res, 200, {
            data: {
                action,
                results: targets,
                succeeded: targets.filter((item) => item.ok).length,
                failed: targets.filter((item) => !item.ok).length,
            },
        });
    });

    router.post('/api/rooms/:id/start', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const result = await supervisor.startRoom(id, { actor: ctx.user.username });
        const room = await ds.findRoomById(id);
        const server = room?.server_id ? await ds.findServerById(room.server_id) : null;
        sendJson(res, result.ok ? 200 : 409, {
            data: room ? roomView(room, { server, supervisor }) : null,
            ...(result.ok ? {} : { error: { message: result.error, code: 'start_failed' } }),
        });
    });

    router.post('/api/rooms/:id/stop', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        await supervisor.stopRoom(id, { actor: ctx.user.username });
        const room = await ds.waitForState(id, (candidate) => candidate.state !== ROOM_STATE.stopping, 6000);
        const server = room?.server_id ? await ds.findServerById(room.server_id) : null;
        sendJson(res, 200, { data: room ? roomView(room, { server, supervisor }) : null });
    });

    router.get('/api/rooms/:id/log', async (req, res, ctx) => {
        auth.assertRole(ctx, 'viewer');
        const id = requireId(ctx.params.id);
        const room = await ds.findRoomById(id);
        if (!room) throw new HttpError(404, '房间不存在', { code: 'not_found' });
        const url = new URL(req.url, 'http://localhost');
        const lines = Number(url.searchParams.get('lines') ?? 200);
        const log = supervisor.readLog(id, { lines: Number.isFinite(lines) ? lines : 200 });
        sendJson(res, 200, { data: { roomId: id, name: room.name, ...log } });
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
        const { validateUsername } = await import('../lib/auth.js');
        const { hashPassword, checkPasswordStrength } = await import('../lib/password.js');
        const username = validateUsername(body.username);
        if (await ds.findUserByUsername(username)) {
            throw new HttpError(409, '用户名已存在', { code: 'duplicate_name', details: { field: 'username' } });
        }
        const strength = checkPasswordStrength(body.password, { minLength: config.auth.passwordMinLength });
        if (!strength.ok) throw new HttpError(400, strength.reason, { code: 'weak_password' });
        const role = requireEnum(body.role ?? 'admin', '角色', ['admin', 'viewer']);
        const id = await ds.createUser({ username, passwordHash: await hashPassword(body.password), role });
        await ds.addEvent({ kind: 'user.created', detail: `新增账户 ${username} (${role})`, actor: ctx.user.username });
        sendJson(res, 201, { data: userView(await ds.findUserById(id)) });
    });

    router.delete('/api/users/:id', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const id = requireId(ctx.params.id);
        const user = await ds.findUserById(id);
        if (!user) throw new HttpError(404, '账户不存在', { code: 'not_found' });
        if (user.role === 'owner') {
            throw new HttpError(403, '不能删除拥有者账户', { code: 'owner_protected' });
        }
        if (user.id === ctx.user.id) {
            throw new HttpError(400, '不能删除当前登录的账户', { code: 'self_delete' });
        }
        await ds.deleteSessionsForUser(id);
        await ds.deleteUser(id);
        await ds.addEvent({ kind: 'user.deleted', detail: `删除账户 ${user.username}`, actor: ctx.user.username });
        sendJson(res, 200, { data: { ok: true } });
    });

    // ---- events ---------------------------------------------------------
    router.get('/api/events', async (req, res, ctx) => {
        auth.assertRole(ctx, 'viewer');
        const url = new URL(req.url, 'http://localhost');
        const roomId = url.searchParams.get('roomId');
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const events = await ds.listEvents({
            roomId: roomId ? requireId(roomId, 'roomId') : null,
            limit: Number.isFinite(limit) ? Math.min(500, Math.max(1, limit)) : 100,
        });
        sendJson(res, 200, { data: events });
    });

    // ---- diagnostics ----------------------------------------------------
    /**
     * What the operator needs to answer "why can this room not start": the
     * resolved binary, the port pools, the datasource in use and the ranges.
     */
    router.get('/api/diagnostics', async (req, res, ctx) => {
        auth.assertRole(ctx, 'admin');
        const used = await ds.listUsedPorts();
        sendJson(res, 200, {
            data: {
                datasource: ds.driver,
                sqlitePath: ds.driver === 'sqlite' ? config.storage.sqlite.path : null,
                gatewayBinary: supervisor?.probeBinary() ?? null,
                gatewayBinaryError: supervisor?.binaryError ?? '',
                citraPortRange: config.gateways.citraPortRange,
                roomPortRange: config.gateways.roomPortRange,
                usedCitraPorts: [...used.citra].sort((a, b) => a - b),
                usedRoomPorts: [...used.room].sort((a, b) => a - b),
                runtimeDir: config.gateways.runtimeDir,
                sampleIntervalMs: config.gateways.sampleIntervalMs,
                configPath: config.configPath ?? null,
                nodeVersion: process.version,
                platform: `${process.platform}/${process.arch}`,
                uptimeSeconds: Math.round(process.uptime()),
            },
        });
    });

    return router;
}
