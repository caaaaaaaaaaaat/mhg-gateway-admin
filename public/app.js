// SPDX-License-Identifier: GPL-3.0-or-later
// Web console front end: one module, no framework, no external requests.
//
// Structure:
//   * `api` wraps fetch with the CSRF header and a uniform error type.
//   * `state` holds the bootstrap session plus the last loaded room/server data.
//   * `views` are pure render functions returning a DOM node; `render()` swaps
//     them into #app and keeps the top bar in sync.
//   * Every user-visible string is Chinese, matching the rest of the project.

const CSRF_HEADER = 'x-csrf-token';

const state = {
    session: null,          // { setupComplete, authenticated, csrfToken, user, ... }
    route: 'dashboard',
    rooms: [],
    servers: [],
    events: [],
    users: [],
    diagnostics: null,
    counts: null,
    busy: new Set(),        // ids of in-flight operations, for button spinners
    refreshTimer: null,
    lastRefresh: null,
};

// ---------------------------------------------------------------------------
// API plumbing
// ---------------------------------------------------------------------------

class ApiError extends Error {
    constructor(message, { status, code, details } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

async function api(path, { method = 'GET', body = undefined } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.session?.csrfToken) {
        headers[CSRF_HEADER] = state.session.csrfToken;
    }
    let response;
    try {
        response = await fetch(path, {
            method,
            headers,
            credentials: 'same-origin',
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError('网络请求失败，请检查与服务器的连接', { status: 0, code: 'network' });
    }
    const text = await response.text();
    let payload = null;
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = null;
        }
    }
    if (!response.ok) {
        const info = payload?.error ?? {};
        const error = new ApiError(info.message ?? `请求失败 (${response.status})`, {
            status: response.status,
            code: info.code,
            details: info.details,
        });
        if (response.status === 401) {
            // Session expired or revoked: drop straight to the login screen.
            state.session = { ...(state.session ?? {}), authenticated: false, csrfToken: null, user: null };
            renderAuth();
        }
        throw error;
    }
    return payload?.data;
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function h(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') element.className = value;
        else if (key === 'text') element.textContent = value;
        else if (key === 'html') element.innerHTML = value; // only for trusted static markup
        else if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'dataset') {
            Object.assign(element.dataset, value);
        } else if (value === true) {
            element.setAttribute(key, '');
        } else {
            element.setAttribute(key, String(value));
        }
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
}

const $app = () => document.getElementById('app');

function fmtTime(ms) {
    if (!ms) return '—';
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fmtDuration(fromMs) {
    if (!fromMs) return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - Number(fromMs)) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
    return `${Math.floor(seconds / 86400)} 天`;
}

function badgeFor(roomState) {
    const labels = {
        running: '运行中', stopped: '已停止', starting: '启动中',
        stopping: '停止中', failed: '异常',
    };
    return h('span', { class: `badge ${roomState ?? 'stopped'}` }, labels[roomState] ?? roomState ?? '未知');
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastHost = null;

function toast(message, kind = 'info', ttl = 4200) {
    if (!toastHost) {
        toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
        document.body.append(toastHost);
    }
    const node = h('div', { class: `toast ${kind === 'info' ? '' : kind}` }, message);
    toastHost.append(node);
    setTimeout(() => {
        node.style.opacity = '0';
        setTimeout(() => node.remove(), 200);
    }, ttl);
}

function fail(error) {
    if (error instanceof ApiError) {
        const details = error.details?.field ? `（${error.details.field}）` : '';
        toast(`${error.message}${details}`, 'error', 6000);
    } else {
        toast(error?.message ?? String(error), 'error', 6000);
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
    try {
        state.session = await api('/api/session');
    } catch (error) {
        $app().replaceChildren(
            h('div', { class: 'auth-shell' },
                h('div', { class: 'auth-card' },
                    h('h1', {}, '无法连接服务器'),
                    h('p', { class: 'lede' }, '页面已加载，但无法获取登录状态。请确认服务仍在运行。'),
                    error instanceof ApiError ? h('div', { class: 'notice error' }, error.message) : null,
                    h('div', { class: 'btn-row' }, h('button', { class: 'primary', onClick: bootstrap }, '重试')),
                )),
        );
        return;
    }
    if (!state.session.setupComplete) {
        renderAuth({ mode: 'setup' });
        return;
    }
    if (!state.session.authenticated) {
        renderAuth({ mode: 'login' });
        return;
    }
    renderShell();
}

// ---------------------------------------------------------------------------
// Auth screens (setup / login)
// ---------------------------------------------------------------------------

function renderAuth({ mode = 'login', notice = null } = {}) {
    stopRefresh();
    const isSetup = mode === 'setup';
    let submitting = false;

    const errorBox = h('div', { hidden: true });
    const showError = (message) => {
        errorBox.hidden = false;
        errorBox.className = 'notice error';
        errorBox.replaceChildren(h('p', {}, message));
    };

    const username = h('input', {
        type: 'text',
        id: 'auth-username',
        autocomplete: isSetup ? 'username' : 'username',
        required: true,
        maxlength: 32,
        placeholder: isSetup ? '例如 admin' : '',
    });
    const password = h('input', {
        type: 'password',
        id: 'auth-password',
        autocomplete: isSetup ? 'new-password' : 'current-password',
        required: true,
        placeholder: isSetup ? `至少 10 个字符` : '',
    });
    const confirm = isSetup
        ? h('input', {
            type: 'password',
            id: 'auth-confirm',
            autocomplete: 'new-password',
            required: true,
            placeholder: '再次输入',
        })
        : null;

    const submit = h('button', { class: 'primary', type: 'submit', style: 'width:100%' },
        isSetup ? '创建管理员并进入' : '登录');

    const form = h('form', {
        onSubmit: async (event) => {
            event.preventDefault();
            if (submitting) return;
            errorBox.hidden = true;
            submitting = true;
            submit.disabled = true;
            submit.replaceChildren(h('span', { class: 'spinner' }), isSetup ? ' 正在创建…' : ' 正在登录…');
            try {
                if (isSetup) {
                    await api('/api/setup', {
                        method: 'POST',
                        body: {
                            username: username.value,
                            password: password.value,
                            confirm: confirm.value,
                        },
                    });
                    // Setup does not sign in (the account is fresh): go to login.
                    renderAuth({ mode: 'login', notice: '管理员账户已创建，请使用刚才的账户登录。' });
                    return;
                }
                await api('/api/login', {
                    method: 'POST',
                    body: { username: username.value, password: password.value },
                });
                await bootstrap();
            } catch (error) {
                if (error instanceof ApiError) showError(error.message);
                else showError(error?.message ?? '操作失败');
                submit.disabled = false;
                submit.textContent = isSetup ? '创建管理员并进入' : '登录';
            } finally {
                submitting = false;
            }
        },
    },
    h('div', { class: 'field' },
        h('label', { for: 'auth-username' }, '管理员账户'),
        username),
    h('div', { class: 'field' },
        h('label', { for: 'auth-password' }, isSetup ? '设置密码' : '密码'),
        password,
        isSetup ? h('span', { class: 'sub' }, '至少 10 个字符，建议混合大小写字母、数字与符号') : null),
    isSetup ? h('div', { class: 'field' }, h('label', { for: 'auth-confirm' }, '确认密码'), confirm) : null,
    errorBox,
    h('div', { class: 'btn-row', style: 'margin-top:6px' }, submit),
    );

    $app().replaceChildren(
        h('div', { class: 'auth-shell' },
            h('div', { class: 'auth-card' },
                h('div', { class: 'brand' },
                    h('span', { class: 'brand-logo' }, 'MH'),
                    h('span', {}, '网关管理控制台')),
                h('h1', {}, isSetup ? '首次使用：创建管理员账户' : '登录'),
                h('p', { class: 'lede' },
                    isSetup
                        ? '这是第一次打开控制台。请创建唯一的管理员账户，之后可以用它登录并创建更多账户。'
                        : '请输入管理员账户与密码。'),
                notice ? h('div', { class: 'notice ok' }, notice) : null,
                form,
                isSetup
                    ? h('p', { class: 'sub muted', style: 'margin-top:14px' },
                        '账户信息保存在本机数据源中，密码以 scrypt 哈希存储，无法还原。')
                    : null,
            )),
    );
    (isSetup ? username : username).focus();
}

// ---------------------------------------------------------------------------
// Shell + navigation
// ---------------------------------------------------------------------------

const NAV = [
    { id: 'dashboard', label: '总览' },
    { id: 'rooms', label: '房间' },
    { id: 'servers', label: '房间服务器' },
    { id: 'events', label: '事件记录' },
    { id: 'users', label: '账户', role: 'admin' },
    { id: 'settings', label: '设置' },
];

function currentRouteFromHash() {
    const raw = (location.hash || '#dashboard').slice(1);
    return NAV.some((item) => item.id === raw) ? raw : 'dashboard';
}

function canSee(item) {
    if (!item.role) return true;
    const role = state.session?.user?.role;
    if (item.role === 'admin') return role === 'admin' || role === 'owner';
    return true;
}

function navigate(route) {
    if (location.hash === `#${route}`) return;
    location.hash = `#${route}`;
}

function renderShell() {
    state.route = currentRouteFromHash();
    const nav = h('nav', { class: 'nav' });
    for (const item of NAV) {
        if (!canSee(item)) continue;
        nav.append(h('button', {
            type: 'button',
            'aria-current': state.route === item.id ? 'page' : null,
            onClick: () => navigate(item.id),
        }, item.label));
    }

    const who = h('div', { class: 'who' },
        h('span', {}, `${state.session.user.username} · ${roleLabel(state.session.user.role)}`),
        h('button', {
            class: 'small',
            type: 'button',
            onClick: async () => {
                try {
                    await api('/api/logout', { method: 'POST' });
                } catch { /* ignore: we leave anyway */ }
                state.session = { ...state.session, authenticated: false, csrfToken: null, user: null };
                renderAuth({ mode: 'login', notice: '已退出登录。' });
            },
        }, '退出'));

    const topbar = h('header', { class: 'topbar' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, 'MH'), h('span', {}, '网关管理')),
        nav,
        h('div', { class: 'topbar-spacer' }),
        who);

    const main = h('main', { id: 'main' });
    $app().replaceChildren(topbar, main);
    renderRoute();
}

function roleLabel(role) {
    return { owner: '拥有者', admin: '管理员', viewer: '只读' }[role] ?? role ?? '未知';
}

async function renderRoute() {
    const main = document.getElementById('main');
    if (!main) return;
    state.route = currentRouteFromHash();
    for (const button of document.querySelectorAll('.nav button')) {
        const label = button.textContent;
        const item = NAV.find((entry) => entry.label === label);
        if (item && item.id === state.route) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    try {
        if (state.route === 'dashboard') await viewDashboard(main);
        else if (state.route === 'rooms') await viewRooms(main);
        else if (state.route === 'servers') await viewServers(main);
        else if (state.route === 'events') await viewEvents(main);
        else if (state.route === 'users') await viewUsers(main);
        else if (state.route === 'settings') await viewSettings(main);
    } catch (error) {
        main.replaceChildren(
            h('div', { class: 'notice error' }, error?.message ?? '加载失败'),
            h('div', { class: 'btn-row' }, h('button', { onClick: renderRoute }, '重新加载')),
        );
    }
}

window.addEventListener('hashchange', () => {
    if (!state.session?.authenticated) return;
    renderRoute();
});

// ---------------------------------------------------------------------------
// Auto refresh
// ---------------------------------------------------------------------------

function startRefresh(callback, intervalMs = 4000) {
    stopRefresh();
    state.refreshTimer = setInterval(() => {
        if (document.hidden) return;
        callback().catch(() => { /* keep the timer alive; the next tick may work */ });
    }, intervalMs);
}

function stopRefresh() {
    if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
    }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function viewDashboard(main) {
    const data = await api('/api/dashboard');
    state.rooms = data.rooms;
    state.servers = data.servers;
    state.counts = data.counts;
    state.lastRefresh = Date.now();

    const stats = h('div', { class: 'grid-stats' },
        h('div', { class: 'stat' },
            h('div', { class: 'stat-label' }, '房间总数'),
            h('div', { class: 'stat-value' }, String(data.counts.total))),
        h('div', { class: 'stat' },
            h('div', { class: 'stat-label' }, '运行中'),
            h('div', { class: 'stat-value ok' }, String(data.counts.running))),
        h('div', { class: 'stat' },
            h('div', { class: 'stat-label' }, '异常'),
            h('div', { class: 'stat-value bad' }, String(data.counts.failed))),
        h('div', { class: 'stat' },
            h('div', { class: 'stat-label' }, '已停止'),
            h('div', { class: 'stat-value' }, String(data.counts.stopped))));

    const blocks = [stats];

    if (!data.gatewayBinaryFound) {
        blocks.push(h('div', { class: 'notice warn' },
            h('strong', {}, '未找到网关程序'),
            h('p', {}, data.gatewayBinaryError || '请在配置中设置 gateways.binaryPath，或把 citra-gateway 放入 bin 目录。'),
            h('p', { class: 'small' }, '在找到网关程序之前，房间可以创建但无法启动。')));
    }
    if (data.counts.total === 0) {
        blocks.push(h('div', { class: 'notice info' },
            h('p', {}, '还没有任何房间。先添加一台房间服务器，然后创建房间即可批量管理网关。'),
            h('div', { class: 'btn-row' },
                h('button', { class: 'primary', onClick: () => navigate('servers') }, '添加房间服务器'),
                h('button', { onClick: () => navigate('rooms') }, '直接去房间页'))));
    }

    const running = data.rooms.filter((room) => room.state === 'running' || room.state === 'failed');
    if (running.length > 0) {
        const rows = running.slice(0, 8).map((room) => h('tr', {},
            h('td', {}, room.name),
            h('td', {}, badgeFor(room.state)),
            h('td', { class: 'num' }, String(room.citraPort)),
            h('td', {}, room.serverName ? `${room.serverName} (${room.serverHost}:${room.serverPort})` : h('span', { class: 'muted' }, '未绑定')),
            h('td', {}, room.state === 'running' ? fmtDuration(room.startedAt) : h('span', { class: 'muted' }, room.failure || '—')),
            h('td', { class: 'actions' },
                h('button', { class: 'small', onClick: () => openLog(room) }, '日志'))));
        blocks.push(h('section', { class: 'card' },
            h('div', { class: 'card-head' },
                h('div', {}, h('h2', {}, '需要关注的房间'),
                    h('p', { class: 'hint' }, '运行中与异常的房间。异常房间的失败原因见“房间”页。'))),
            h('div', { class: 'table-wrap' },
                h('table', {},
                    h('thead', {}, h('tr', {},
                        h('th', {}, '房间'), h('th', {}, '状态'), h('th', {}, 'Citra 端口'),
                        h('th', {}, '房间服务器'), h('th', {}, '运行时长 / 原因'), h('th', {}, ''))),
                    h('tbody', {}, rows)))));
    }

    if (data.events.length > 0) {
        blocks.push(h('section', { class: 'card' },
            h('div', { class: 'card-head' },
                h('div', {}, h('h2', {}, '最近事件'),
                    h('p', { class: 'hint' }, '启动、停止、异常退出与配置改动都会记录在这里。'))),
            h('div', { class: 'table-wrap' },
                h('table', { style: 'min-width:560px' },
                    h('thead', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '事件'), h('th', {}, '详情'), h('th', {}, '操作者'))),
                    h('tbody', {}, data.events.slice(0, 12).map((event) => h('tr', {},
                        h('td', { class: 'nowrap' }, fmtTime(event.at)),
                        h('td', { class: 'mono' }, event.kind),
                        h('td', {}, event.detail || '—'),
                        h('td', {}, event.actor || '—'))))))));
    }

    blocks.push(h('p', { class: 'small muted' },
        `数据每 4 秒自动刷新 · 最近刷新 ${fmtTime(state.lastRefresh)}`));

    main.replaceChildren(...blocks);
    startRefresh(async () => {
        if (state.route === 'dashboard') await viewDashboard(document.getElementById('main'));
    }, 4000);
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

let selectedRooms = new Set();

async function viewRooms(main) {
    const [rooms, servers] = await Promise.all([api('/api/rooms'), api('/api/servers')]);
    state.rooms = rooms;
    state.servers = servers;
    const canEdit = state.session.user.role === 'admin' || state.session.user.role === 'owner';

    // Drop selections that no longer exist (e.g. deleted in another tab).
    for (const id of [...selectedRooms]) {
        if (!rooms.some((room) => room.id === id)) selectedRooms.delete(id);
    }

    const head = h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, '房间'),
            h('p', { class: 'hint' },
                '每个房间是一个独立的网关进程。玩家把 Citra 连接到房间的 Citra 端口，Yuzu 在游戏内加入对应厅。')),
        h('div', { class: 'btn-row' },
            h('button', { onClick: () => refreshRooms() }, '刷新'),
            canEdit ? h('button', { class: 'primary', onClick: () => openRoomDialog(null, servers) }, '新建房间') : null));

    const notice = servers.length === 0
        ? h('div', { class: 'notice warn' },
            h('p', {}, '还没有可用的房间服务器。房间必须绑定一台房间服务器才能启动。'),
            h('div', { class: 'btn-row' }, h('button', { onClick: () => navigate('servers') }, '去添加房间服务器')))
        : null;

    const body = rooms.length === 0
        ? h('div', { class: 'empty' },
            h('strong', {}, '还没有房间'),
            h('p', {}, '创建第一个房间后，可以在这里批量启动、停止并查看日志。'))
        : h('div', { class: 'table-wrap' },
            h('table', {},
                h('thead', {}, h('tr', {},
                    canEdit ? h('th', { style: 'width:36px' },
                        h('input', {
                            type: 'checkbox',
                            'aria-label': '全选',
                            checked: rooms.length > 0 && selectedRooms.size === rooms.length,
                            onChange: (event) => {
                                if (event.target.checked) rooms.forEach((room) => selectedRooms.add(room.id));
                                else selectedRooms.clear();
                                refreshRooms();
                            },
                        })) : null,
                    h('th', {}, '房间'),
                    h('th', {}, '状态'),
                    h('th', {}, 'Citra 端口'),
                    h('th', {}, '房间服务器'),
                    h('th', {}, '配置档'),
                    h('th', {}, '运行时长'),
                    h('th', {}, canEdit ? '操作' : ''))),
                h('tbody', {}, rooms.map((room) => roomRow(room, { canEdit, servers })))));

    const batchBar = canEdit && rooms.length > 0
        ? h('div', { class: 'card', style: 'margin-bottom:16px' },
            h('div', { class: 'spread', style: 'flex-wrap:wrap' },
                h('span', { class: 'small muted' }, `已选择 ${selectedRooms.size} 个房间`),
                h('div', { class: 'btn-row' },
                    h('button', {
                        disabled: selectedRooms.size === 0,
                        onClick: () => batch('start'),
                    }, '批量启动'),
                    h('button', {
                        disabled: selectedRooms.size === 0,
                        onClick: () => batch('stop'),
                    }, '批量停止'),
                    h('button', {
                        disabled: selectedRooms.size === 0,
                        onClick: () => {
                            if (!confirm(`确定要删除选中的 ${selectedRooms.size} 个房间吗？正在运行的房间会先被停止。`)) return;
                            (async () => {
                                for (const id of [...selectedRooms]) {
                                    try {
                                        await api(`/api/rooms/${id}`, { method: 'DELETE' });
                                    } catch (error) {
                                        fail(error);
                                    }
                                }
                                selectedRooms.clear();
                                toast('已删除选中的房间');
                                await refreshRooms();
                            })();
                        },
                    }, '批量删除'))))
        : null;

    main.replaceChildren(
        h('section', { class: 'card' }, head, notice, body),
        batchBar ?? h('div'),
    );

    startRefresh(async () => {
        if (state.route !== 'rooms') return;
        const fresh = await api('/api/rooms');
        state.rooms = fresh;
        // Update only the volatile cells so an open dialog or in-progress click
        // is not destroyed by the refresh.
        for (const room of fresh) {
            const row = document.querySelector(`tr[data-room="${room.id}"]`);
            if (!row) { await refreshRooms(); return; }
            const stateCell = row.querySelector('[data-cell="state"]');
            if (stateCell) stateCell.replaceChildren(badgeFor(room.state));
            const uptimeCell = row.querySelector('[data-cell="uptime"]');
            if (uptimeCell) uptimeCell.textContent = room.state === 'running' ? fmtDuration(room.startedAt) : '—';
            const failureCell = row.querySelector('[data-cell="failure"]');
            if (failureCell) failureCell.textContent = room.failure || '';
        }
    }, 4000);
}

function roomRow(room, { canEdit, servers }) {
    const busy = state.busy.has(`room-${room.id}`);
    const canStart = canEdit && !busy && room.state !== 'running' && room.state !== 'starting' && room.serverId;
    const canStop = canEdit && !busy && (room.state === 'running' || room.state === 'starting');
    return h('tr', { dataset: { room: String(room.id) } },
        canEdit ? h('td', {},
            h('input', {
                type: 'checkbox',
                'aria-label': `选择 ${room.name}`,
                checked: selectedRooms.has(room.id),
                onChange: (event) => {
                    if (event.target.checked) selectedRooms.add(room.id);
                    else selectedRooms.delete(room.id);
                    const bar = document.querySelector('.card .spread .small.muted');
                    if (bar) bar.textContent = `已选择 ${selectedRooms.size} 个房间`;
                },
            })) : null,
        h('td', {},
            h('div', { style: 'font-weight:600' }, room.name),
            room.failure ? h('div', { class: 'small', style: 'color:var(--danger)', 'data-cell': 'failure' }, room.failure) : null),
        h('td', { 'data-cell': 'state' }, badgeFor(room.state)),
        h('td', { class: 'num' }, String(room.citraPort)),
        h('td', {},
            room.serverName
                ? h('div', {}, `${room.serverName}`, h('div', { class: 'small muted' }, `${room.serverHost}:${room.serverPort}`))
                : h('span', { class: 'muted' }, '未绑定')),
        h('td', {}, room.profile === 'legacy' ? '兼容模式' : room.profile === 'dual-host' ? '双房主' : '标准'),
        h('td', { class: 'nowrap', 'data-cell': 'uptime' }, room.state === 'running' ? fmtDuration(room.startedAt) : '—'),
        h('td', { class: 'actions' },
            canStart ? h('button', { class: 'small', onClick: () => roomAction(room, 'start') }, '启动') : null,
            canStop ? h('button', { class: 'small', onClick: () => roomAction(room, 'stop') }, '停止') : null,
            h('button', { class: 'small', onClick: () => openLog(room) }, '日志'),
            canEdit ? h('button', { class: 'small', onClick: () => openRoomDialog(room, servers) }, '编辑') : null,
            canEdit ? h('button', {
                class: 'small danger',
                onClick: () => {
                    if (!confirm(`确定要删除房间“${room.name}”吗？`)) return;
                    api(`/api/rooms/${room.id}`, { method: 'DELETE' })
                        .then(() => { toast('房间已删除'); return refreshRooms(); })
                        .catch(fail);
                },
            }, '删除') : null),
    );
}

async function refreshRooms() {
    // Re-render in place; keeps checkboxes and scroll position for the operator.
    const main = document.getElementById('main');
    if (main && state.route === 'rooms') await viewRooms(main);
}

async function roomAction(room, action) {
    const key = `room-${room.id}`;
    state.busy.add(key);
    try {
        const result = await api(`/api/rooms/${room.id}/${action}`, { method: 'POST' });
        if (action === 'start' && result?.state === 'failed') {
            toast(`启动失败：${result.failure || '未知原因'}`, 'error', 7000);
        } else {
            toast(action === 'start' ? `已启动 ${room.name}` : `已停止 ${room.name}`);
        }
    } catch (error) {
        fail(error);
    } finally {
        state.busy.delete(key);
        await refreshRooms();
    }
}

async function batch(action) {
    const ids = [...selectedRooms];
    if (ids.length === 0) return;
    try {
        const result = await api(`/api/rooms/batch/${action}`, { method: 'POST', body: { ids } });
        if (result.failed === 0) {
            toast(`已${action === 'start' ? '启动' : '停止'} ${result.succeeded} 个房间`);
        } else {
            const reasons = result.results.filter((item) => !item.ok)
                .map((item) => `· ${item.name ?? `#${item.id}`}: ${item.error ?? '未知原因'}`)
                .join('\n');
            toast(`${action === 'start' ? '启动' : '停止'}成功 ${result.succeeded} 个，失败 ${result.failed} 个`, 'warn', 9000);
            showBatchErrors(action, reasons);
        }
    } catch (error) {
        fail(error);
    } finally {
        await refreshRooms();
    }
}

function showBatchErrors(action, text) {
    const dialog = h('dialog', { open: true },
        h('div', { style: 'padding:20px' },
            h('div', { class: 'dialog-head' },
                h('h2', {}, `批量${action === 'start' ? '启动' : '停止'}部分失败`),
                h('p', { class: 'hint' }, '成功的房间已经生效，下面是失败原因。')),
            h('pre', {}, text),
            h('div', { class: 'dialog-actions' },
                h('button', { class: 'primary', onClick: () => { dialog.close(); dialog.remove(); } }, '知道了'))));
    document.body.append(dialog);
}

// ---- room create/edit dialog ---------------------------------------------

function openRoomDialog(room, servers) {
    const editing = Boolean(room);
    const name = h('input', { type: 'text', value: room?.name ?? '', maxlength: 32, required: true, placeholder: '例如 大厅-1' });
    const serverSelect = h('select', {},
        servers.map((server) => h('option', {
            value: String(server.id),
            selected: room ? server.id === room.serverId : servers.length === 1,
        }, `${server.name} (${server.host}:${server.port})`)));
    const citraPort = h('input', {
        type: 'number', min: 1, max: 65535,
        value: room?.citraPort ?? '',
        placeholder: '留空自动分配',
    });
    const roomPort = h('input', {
        type: 'number', min: 1, max: 65535,
        value: room?.roomPort ?? '',
        placeholder: '留空自动分配',
    });
    const listen = h('input', { type: 'text', value: room?.listenAddress ?? '0.0.0.0', placeholder: '0.0.0.0' });
    const password = h('input', {
        type: 'password',
        value: '',
        placeholder: room?.hasPassword ? '已设置，留空表示不修改' : '可留空表示无密码',
        autocomplete: 'new-password',
    });
    const profile = h('select', {},
        h('option', { value: 'default', selected: (room?.profile ?? 'default') === 'default' }, '标准（MHXX ↔ MHGU 互转）'),
        h('option', { value: 'dual-host', selected: room?.profile === 'dual-host' }, '双房主'),
        h('option', { value: 'legacy', selected: room?.profile === 'legacy' }, '兼容模式（仅数据面转发）'));

    const errorBox = h('div', { hidden: true });
    const submit = h('button', { class: 'primary', type: 'submit' }, editing ? '保存' : '创建');

    const dialog = h('dialog', {},
        h('form', {
            onSubmit: async (event) => {
                event.preventDefault();
                errorBox.hidden = true;
                submit.disabled = true;
                const body = {
                    name: name.value,
                    serverId: Number(serverSelect.value),
                    listenAddress: listen.value,
                    profile: profile.value,
                };
                if (citraPort.value !== '') body.citraPort = Number(citraPort.value);
                if (roomPort.value !== '') body.roomPort = Number(roomPort.value);
                if (password.value !== '') body.password = password.value;
                try {
                    if (editing) await api(`/api/rooms/${room.id}`, { method: 'PATCH', body });
                    else await api('/api/rooms', { method: 'POST', body });
                    dialog.close();
                    dialog.remove();
                    toast(editing ? '房间已保存' : '房间已创建');
                    await refreshRooms();
                } catch (error) {
                    errorBox.hidden = false;
                    errorBox.className = 'notice error';
                    errorBox.replaceChildren(h('p', {}, error?.message ?? '保存失败'));
                    submit.disabled = false;
                }
            },
        },
        h('div', { class: 'dialog-head' },
            h('h2', {}, editing ? `编辑房间 ${room.name}` : '新建房间'),
            h('p', { class: 'hint' }, '端口留空会根据配置的端口池自动分配，避免冲突。')),
        errorBox,
        h('div', { class: 'field' }, h('label', {}, '房间名'), name),
        h('div', { class: 'field' }, h('label', {}, '房间服务器'), serverSelect,
            h('span', { class: 'sub' }, 'Yuzu 玩家加入的服务器，必须是已配置的服务器。')),
        h('div', { class: 'field-row' },
            h('div', { class: 'field' }, h('label', {}, 'Citra 接入端口'), citraPort,
                h('span', { class: 'sub' }, 'Citra 玩家连接此端口')),
            h('div', { class: 'field' }, h('label', {}, '房间服务器端口'), roomPort,
                h('span', { class: 'sub' }, '网关向服务器声明的端口'))),
        h('div', { class: 'field-row' },
            h('div', { class: 'field' }, h('label', {}, '监听地址'), listen,
                h('span', { class: 'sub' }, '0.0.0.0 表示接受外部连接')),
            h('div', { class: 'field' }, h('label', {}, 'Citra 接入密码'), password)),
        h('div', { class: 'field' }, h('label', {}, '配置档'), profile),
        h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', onClick: () => { dialog.close(); dialog.remove(); } }, '取消'),
            submit)),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    name.focus();
}

// ---- log viewer -----------------------------------------------------------

async function openLog(room) {
    const pre = h('pre', { class: 'log-view' }, '正在读取日志…');
    const dialog = h('dialog', {},
        h('div', { style: 'padding:20px' },
            h('div', { class: 'dialog-head' },
                h('h2', {}, `${room.name} 日志`),
                h('p', { class: 'hint' }, '最近的输出，最多显示 200 行。')),
            pre,
            h('div', { class: 'dialog-actions' },
                h('button', {
                    type: 'button',
                    onClick: async () => {
                        try {
                            const log = await api(`/api/rooms/${room.id}/log?lines=400`);
                            pre.textContent = log.text || '（日志为空）';
                        } catch (error) {
                            fail(error);
                        }
                    },
                }, '刷新'),
                h('button', { class: 'primary', type: 'button', onClick: () => { dialog.close(); dialog.remove(); } }, '关闭'))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    try {
        const log = await api(`/api/rooms/${room.id}/log?lines=400`);
        pre.textContent = log.text || '（日志为空：房间可能从未启动过）';
    } catch (error) {
        pre.textContent = `读取日志失败：${error?.message ?? error}`;
    }
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

async function viewServers(main) {
    const servers = await api('/api/servers');
    state.servers = servers;
    stopRefresh();
    const canEdit = state.session.user.role === 'admin' || state.session.user.role === 'owner';

    const head = h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, '房间服务器'),
            h('p', { class: 'hint' }, 'Yuzu 玩家实际加入的房间服务器。房间会绑定其中一台。')),
        h('div', { class: 'btn-row' },
            canEdit ? h('button', { class: 'primary', onClick: () => openServerDialog(null) }, '添加服务器') : null));

    const body = servers.length === 0
        ? h('div', { class: 'empty' },
            h('strong', {}, '还没有房间服务器'),
            h('p', {}, '先添加一台 yuzu-room 服务器，之后创建房间时选择它。'))
        : h('div', { class: 'table-wrap' },
            h('table', { style: 'min-width:620px' },
                h('thead', {}, h('tr', {},
                    h('th', {}, '名称'), h('th', {}, '地址'), h('th', {}, '端口'),
                    h('th', {}, '密码'), h('th', {}, '备注'), h('th', {}, canEdit ? '操作' : ''))),
                h('tbody', {}, servers.map((server) => h('tr', {},
                    h('td', { style: 'font-weight:600' }, server.name),
                    h('td', { class: 'mono' }, server.host),
                    h('td', { class: 'num' }, String(server.port)),
                    h('td', {}, server.hasPassword ? '已设置' : h('span', { class: 'muted' }, '无')),
                    h('td', {}, server.notes || h('span', { class: 'muted' }, '—')),
                    h('td', { class: 'actions' },
                        canEdit ? h('button', { class: 'small', onClick: () => openServerDialog(server) }, '编辑') : null,
                        canEdit ? h('button', {
                            class: 'small danger',
                            onClick: async () => {
                                if (!confirm(`确定要删除服务器“${server.name}”吗？`)) return;
                                try {
                                    await api(`/api/servers/${server.id}`, { method: 'DELETE' });
                                    toast('服务器已删除');
                                    await viewServers(main);
                                } catch (error) {
                                    fail(error);
                                }
                            },
                        }, '删除') : null)))))
        ;

    main.replaceChildren(h('section', { class: 'card' }, head, body));
}

function openServerDialog(server) {
    const editing = Boolean(server);
    const name = h('input', { type: 'text', value: server?.name ?? '', maxlength: 64, required: true, placeholder: '例如 主服务器' });
    const host = h('input', { type: 'text', value: server?.host ?? '', required: true, placeholder: '例如 192.168.1.10 或 room.example.com' });
    const port = h('input', { type: 'number', value: server?.port ?? 24872, min: 1, max: 65535, required: true });
    const password = h('input', {
        type: 'password', value: '',
        placeholder: server?.hasPassword ? '已设置，留空表示不修改' : '可留空',
        autocomplete: 'new-password',
    });
    const notes = h('textarea', { placeholder: '可选，例如负责人或机房位置' }, server?.notes ?? '');
    const errorBox = h('div', { hidden: true });
    const submit = h('button', { class: 'primary', type: 'submit' }, editing ? '保存' : '添加');

    const dialog = h('dialog', {},
        h('form', {
            onSubmit: async (event) => {
                event.preventDefault();
                errorBox.hidden = true;
                submit.disabled = true;
                const body = {
                    name: name.value,
                    host: host.value,
                    port: Number(port.value),
                    notes: notes.value,
                };
                if (password.value !== '') body.password = password.value;
                try {
                    if (editing) await api(`/api/servers/${server.id}`, { method: 'PATCH', body });
                    else await api('/api/servers', { method: 'POST', body });
                    dialog.close();
                    dialog.remove();
                    toast(editing ? '服务器已保存' : '服务器已添加');
                    await viewServers(document.getElementById('main'));
                } catch (error) {
                    errorBox.hidden = false;
                    errorBox.className = 'notice error';
                    errorBox.replaceChildren(h('p', {}, error?.message ?? '保存失败'));
                    submit.disabled = false;
                }
            },
        },
        h('div', { class: 'dialog-head' }, h('h2', {}, editing ? `编辑服务器 ${server.name}` : '添加房间服务器')),
        errorBox,
        h('div', { class: 'field' }, h('label', {}, '名称'), name),
        h('div', { class: 'field-row' },
            h('div', { class: 'field' }, h('label', {}, '地址'), host,
                h('span', { class: 'sub' }, 'IPv4 或域名，不要带端口')),
            h('div', { class: 'field' }, h('label', {}, '端口'), port)),
        h('div', { class: 'field' }, h('label', {}, '房间密码'), password),
        h('div', { class: 'field' }, h('label', {}, '备注'), notes),
        h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', onClick: () => { dialog.close(); dialog.remove(); } }, '取消'),
            submit)),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    name.focus();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function viewEvents(main) {
    const events = await api('/api/events?limit=300');
    state.events = events;
    stopRefresh();
    const rows = events.map((event) => h('tr', {},
        h('td', { class: 'nowrap' }, fmtTime(event.at)),
        h('td', { class: 'mono' }, event.kind),
        h('td', {}, event.detail || '—'),
        h('td', {}, event.actor || '—'),
        h('td', { class: 'num' }, event.room_id ? String(event.room_id) : '—')));

    main.replaceChildren(h('section', { class: 'card' },
        h('div', { class: 'card-head' },
            h('div', {}, h('h2', {}, '事件记录'),
                h('p', { class: 'hint' }, '最近 300 条。包含登录、配置改动与房间生命周期。')),
            h('div', { class: 'btn-row' }, h('button', { onClick: () => viewEvents(main) }, '刷新'))),
        events.length === 0
            ? h('div', { class: 'empty' }, h('strong', {}, '暂无事件'))
            : h('div', { class: 'table-wrap' },
                h('table', { style: 'min-width:700px' },
                    h('thead', {}, h('tr', {},
                        h('th', {}, '时间'), h('th', {}, '事件'), h('th', {}, '详情'),
                        h('th', {}, '操作者'), h('th', {}, '房间'))),
                    h('tbody', {}, rows)))));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function viewUsers(main) {
    const users = await api('/api/users');
    state.users = users;
    stopRefresh();
    const isOwner = state.session.user.role === 'owner' || state.session.user.role === 'admin';

    const head = h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, '账户'),
            h('p', { class: 'hint' }, '管理员可以管理房间；只读账户只能查看状态与日志。')),
        h('div', { class: 'btn-row' },
            isOwner ? h('button', { class: 'primary', onClick: () => openUserDialog() }, '添加账户') : null));

    main.replaceChildren(h('section', { class: 'card' }, head,
        h('div', { class: 'table-wrap' },
            h('table', { style: 'min-width:620px' },
                h('thead', {}, h('tr', {},
                    h('th', {}, '账户'), h('th', {}, '角色'), h('th', {}, '最近登录'),
                    h('th', {}, '创建时间'), h('th', {}, '状态'), h('th', {}, '操作'))),
                h('tbody', {}, users.map((user) => h('tr', {},
                    h('td', { style: 'font-weight:600' }, user.username),
                    h('td', {}, roleLabel(user.role)),
                    h('td', { class: 'nowrap' }, fmtTime(user.lastLoginAt)),
                    h('td', { class: 'nowrap' }, fmtTime(user.createdAt)),
                    h('td', {}, user.disabled
                        ? h('span', { class: 'badge failed' }, '已禁用')
                        : user.lockedUntil && user.lockedUntil > Date.now()
                            ? h('span', { class: 'badge failed' }, '锁定中')
                            : h('span', { class: 'badge running' }, '正常')),
                    h('td', { class: 'actions' },
                        user.role === 'owner'
                            ? h('span', { class: 'small muted' }, '拥有者')
                            : h('button', {
                                class: 'small danger',
                                onClick: async () => {
                                    if (!confirm(`确定要删除账户“${user.username}”吗？`)) return;
                                    try {
                                        await api(`/api/users/${user.id}`, { method: 'DELETE' });
                                        toast('账户已删除');
                                        await viewUsers(main);
                                    } catch (error) {
                                        fail(error);
                                    }
                                },
                            }, '删除'))))))))));
}

function openUserDialog() {
    const username = h('input', { type: 'text', required: true, maxlength: 32, placeholder: '3-32 个字符' });
    const password = h('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: '至少 10 个字符' });
    const role = h('select', {},
        h('option', { value: 'admin' }, '管理员（可管理房间）'),
        h('option', { value: 'viewer' }, '只读（仅查看）'));
    const errorBox = h('div', { hidden: true });
    const submit = h('button', { class: 'primary', type: 'submit' }, '创建');

    const dialog = h('dialog', {},
        h('form', {
            onSubmit: async (event) => {
                event.preventDefault();
                errorBox.hidden = true;
                submit.disabled = true;
                try {
                    await api('/api/users', {
                        method: 'POST',
                        body: { username: username.value, password: password.value, role: role.value },
                    });
                    dialog.close();
                    dialog.remove();
                    toast('账户已创建');
                    await viewUsers(document.getElementById('main'));
                } catch (error) {
                    errorBox.hidden = false;
                    errorBox.className = 'notice error';
                    errorBox.replaceChildren(h('p', {}, error?.message ?? '创建失败'));
                    submit.disabled = false;
                }
            },
        },
        h('div', { class: 'dialog-head' }, h('h2', {}, '添加账户')),
        errorBox,
        h('div', { class: 'field' }, h('label', {}, '账户名'), username),
        h('div', { class: 'field' }, h('label', {}, '密码'), password),
        h('div', { class: 'field' }, h('label', {}, '角色'), role),
        h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', onClick: () => { dialog.close(); dialog.remove(); } }, '取消'),
            submit)),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    username.focus();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function viewSettings(main) {
    stopRefresh();
    const canAdmin = state.session.user.role === 'admin' || state.session.user.role === 'owner';
    const diagnostics = canAdmin ? await api('/api/diagnostics') : null;
    state.diagnostics = diagnostics;

    const blocks = [];

    // ---- own password ----
    const currentPassword = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const newPassword = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const confirmPassword = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const pwMessage = h('div', { hidden: true });
    const pwForm = h('form', {
        onSubmit: async (event) => {
            event.preventDefault();
            pwMessage.hidden = true;
            try {
                await api('/api/password', {
                    method: 'POST',
                    body: {
                        currentPassword: currentPassword.value,
                        newPassword: newPassword.value,
                        confirm: confirmPassword.value,
                    },
                });
                pwMessage.hidden = false;
                pwMessage.className = 'notice ok';
                pwMessage.replaceChildren(h('p', {}, '密码已修改，所有会话已失效，请用新密码重新登录。'));
                setTimeout(() => {
                    state.session = { ...state.session, authenticated: false, csrfToken: null, user: null };
                    renderAuth({ mode: 'login', notice: '密码已修改，请重新登录。' });
                }, 1200);
            } catch (error) {
                pwMessage.hidden = false;
                pwMessage.className = 'notice error';
                pwMessage.replaceChildren(h('p', {}, error?.message ?? '修改失败'));
            }
        },
    },
    h('div', { class: 'field' }, h('label', {}, '当前密码'), currentPassword),
    h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', {}, '新密码'), newPassword),
        h('div', { class: 'field' }, h('label', {}, '确认新密码'), confirmPassword)),
    pwMessage,
    h('div', { class: 'btn-row' }, h('button', { class: 'primary', type: 'submit' }, '修改密码')));

    blocks.push(h('section', { class: 'card' },
        h('div', { class: 'card-head' },
            h('div', {}, h('h2', {}, '我的账户'),
                h('p', { class: 'hint' }, `${state.session.user.username} · ${roleLabel(state.session.user.role)}`))),
        pwForm));

    // ---- session / deployment facts ----
    if (canAdmin && diagnostics) {
        const rows = [
            ['数据源', diagnostics.datasource === 'sqlite' ? `SQLite (${diagnostics.sqlitePath})` : 'MySQL'],
            ['配置文件', diagnostics.configPath ?? '未使用配置文件（内置默认值）'],
            ['网关程序', diagnostics.gatewayBinary ?? '未找到'],
            ['网关程序问题', diagnostics.gatewayBinaryError || '无'],
            ['Citra 端口池', `${diagnostics.citraPortRange[0]} - ${diagnostics.citraPortRange[1]}（已用 ${diagnostics.usedCitraPorts.length}）`],
            ['房间端口池', `${diagnostics.roomPortRange[0]} - ${diagnostics.roomPortRange[1]}（已用 ${diagnostics.usedRoomPorts.length}）`],
            ['运行目录', diagnostics.runtimeDir],
            ['采样间隔', `${diagnostics.sampleIntervalMs} ms`],
            ['运行环境', `${diagnostics.platform} · Node ${diagnostics.nodeVersion}`],
            ['已运行', fmtDuration(Date.now() - diagnostics.uptimeSeconds * 1000)],
        ];
        blocks.push(h('section', { class: 'card' },
            h('div', { class: 'card-head' },
                h('div', {}, h('h2', {}, '部署信息'),
                    h('p', { class: 'hint' }, '只读。要修改端口池、数据源或网关路径，请编辑 config.json 后重启服务。'))),
            h('div', { class: 'table-wrap' },
                h('table', { style: 'min-width:520px' },
                    h('tbody', {}, rows.map(([label, value]) => h('tr', {},
                        h('td', { style: 'width:150px;color:var(--muted)' }, label),
                        h('td', { class: 'mono' }, value === undefined || value === null ? '—' : String(value)))))))));
    }

    blocks.push(h('section', { class: 'card' },
        h('div', { class: 'card-head' },
            h('div', {}, h('h2', {}, '关于'),
                h('p', { class: 'hint' }, 'MHXX/MHGU 网关批量管理控制台，用于在服务器上管理多个房间网关进程。'))),
        h('p', { class: 'small muted' },
            '房间的协议翻译由 citra-gateway 完成；本控制台只负责进程生命周期、端口分配与配置存放。' +
            '带密码的房间不会把密码回显给浏览器，也不会写入日志。')));

    main.replaceChildren(...blocks);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

bootstrap().catch((error) => {
    $app().replaceChildren(
        h('div', { class: 'auth-shell' },
            h('div', { class: 'auth-card' },
                h('h1', {}, '页面初始化失败'),
                h('pre', { style: 'max-height:40vh' }, error?.stack ?? String(error)))),
    );
});
