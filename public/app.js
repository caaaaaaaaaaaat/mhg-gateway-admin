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
    mappings: [],           // rows from /api/mappings or /api/dashboard
    events: [],
    users: [],
    diagnostics: null,
    counts: null,
    localPortRange: null,
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
        else if (key === 'style') {
            // Assign through CSSOM, not setAttribute('style', ...). The page ships a
            // strict `style-src 'self'` policy, which blocks inline style attributes:
            // going through the attribute silently drops every layout tweak the views
            // rely on (and logs a CSP violation). CSSOM writes are not inline styles,
            // so the strict policy can stay.
            element.style.cssText = String(value);
        } else if (key.startsWith('on') && typeof value === 'function') {
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
    { id: 'mappings', label: '端口映射' },
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
        else if (state.route === 'mappings') await viewMappings(main);
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
    state.mappings = data.mappings;
    state.counts = data.counts;
    state.localPortRange = data.localPortRange ?? null;
    state.lastRefresh = Date.now();

    const stats = h('div', { class: 'grid-stats' },
        h('div', { class: 'stat' },
            h('div', { class: 'stat-label' }, '映射总数'),
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
            h('p', { class: 'small' }, '在找到网关程序之前，映射可以创建但无法启动。')));
    }

    if (data.counts.total === 0) {
        blocks.push(h('div', { class: 'notice info' },
            h('p', {}, '还没有任何端口映射。一条映射 = 一个本地端口对应一台房间服务器。'),
            h('div', { class: 'btn-row' },
                h('button', { class: 'primary', onClick: () => navigate('mappings') }, '去添加映射'))));
    }

    const active = data.mappings.filter((row) => row.state === 'running' || row.state === 'failed');
    if (active.length > 0) {
        const rows = active.slice(0, 8).map((row) => h('tr', {},
            h('td', {}, row.name),
            h('td', {}, badgeFor(row.state)),
            h('td', { class: 'num' }, String(row.localPort)),
            h('td', { class: 'mono' }, `${row.targetHost}:${row.targetPort}`),
            h('td', {}, row.state === 'running'
                ? fmtDuration(row.startedAt)
                : h('span', { class: 'muted' }, row.failure || '—')),
            h('td', { class: 'actions' },
                h('button', { class: 'small', onClick: () => openLog(row) }, '日志'))));
        const activeTable = h('table', { style: 'min-width:620px' },
            h('thead', {}, h('tr', {},
                h('th', {}, '名称'), h('th', {}, '状态'), h('th', {}, '本地端口'),
                h('th', {}, '目标服务器'), h('th', {}, '运行时长 / 原因'), h('th', {}, ''))),
            h('tbody', {}, rows));
        blocks.push(h('section', { class: 'card' },
            h('div', { class: 'card-head' },
                h('div', {}, h('h2', {}, '需要关注的映射'),
                    h('p', { class: 'hint' }, '运行中与异常的映射。异常原因见「端口映射」页。'))),
            h('div', { class: 'table-wrap' }, activeTable)));
    }

    if (data.events.length > 0) {
        const eventRows = data.events.slice(0, 12).map((event) => h('tr', {},
            h('td', { class: 'nowrap' }, fmtTime(event.at)),
            h('td', { class: 'mono' }, event.kind),
            h('td', {}, event.detail || '—'),
            h('td', {}, event.actor || '—')));
        const eventTable = h('table', { style: 'min-width:560px' },
            h('thead', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '事件'), h('th', {}, '详情'), h('th', {}, '操作者'))),
            h('tbody', {}, eventRows));
        blocks.push(h('section', { class: 'card' },
            h('div', { class: 'card-head' },
                h('div', {}, h('h2', {}, '最近事件'),
                    h('p', { class: 'hint' }, '启动、停止、异常退出与配置改动都会记录在这里。'))),
            h('div', { class: 'table-wrap' }, eventTable)));
    }

    blocks.push(h('p', { class: 'small muted' },
        `数据每 4 秒自动刷新 · 最近刷新 ${fmtTime(state.lastRefresh)}`));

    main.replaceChildren(...blocks);
    startRefresh(async () => {
        if (state.route === 'dashboard') await viewDashboard(document.getElementById('main'));
    }, 4000);
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

let selectedMappings = new Set();

async function viewMappings(main) {
    const mappings = await api('/api/mappings');
    state.mappings = mappings;
    const canEdit = state.session.user.role === 'admin' || state.session.user.role === 'owner';

    // Drop selections that no longer exist (e.g. deleted in another tab).
    for (const id of [...selectedMappings]) {
        if (!mappings.some((row) => row.id === id)) selectedMappings.delete(id);
    }

    const head = h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, '端口映射'),
            h('p', { class: 'hint' },
                '一条映射就是一对：本地端口（玩家连这个）→ 目标房间服务器。批量启动后每个映射各占一个网关进程。')),
        h('div', { class: 'btn-row' },
            h('button', { onClick: () => viewMappings(main) }, '刷新'),
            canEdit ? h('button', { class: 'primary', onClick: () => openMappingDialog(null) }, '新建映射') : null));

    if (mappings.length === 0) {
        main.replaceChildren(h('section', { class: 'card' }, head,
            h('div', { class: 'empty' },
                h('strong', {}, '还没有端口映射'),
                h('p', {}, '新建一条映射：选一个本地端口，填上房间服务器的地址和端口，再批量启动即可。'))));
        return;
    }

    const rows = mappings.map((row) => mappingRow(row, { canEdit }));
    const table = h('table', { style: 'min-width:900px' },
        h('thead', {}, h('tr', {},
            canEdit ? h('th', { style: 'width:36px' }, '') : null,
            h('th', {}, '名称'),
            h('th', {}, '本地端口'),
            h('th', {}, '目标服务器'),
            h('th', {}, '密码'),
            h('th', {}, '配置档'),
            h('th', {}, '状态'),
            h('th', {}, '运行时长 / 原因'),
            h('th', {}, '操作'))),
        h('tbody', {}, rows));

    const batchBar = canEdit ? buildBatchBar(mappings) : null;
    main.replaceChildren(h('section', { class: 'card' }, head, batchBar,
        h('div', { class: 'table-wrap' }, table)));

    startRefresh(async () => {
        if (state.route === 'mappings') await viewMappings(document.getElementById('main'));
    }, 4000);
}

/** The selection bar above the table: count, select-all, batch buttons. */
function buildBatchBar(mappings) {
    const label = h('span', { class: 'small muted' }, `已选择 ${selectedMappings.size} 个映射`);
    const bar = h('div', { class: 'batch-bar' },
        label,
        h('div', { class: 'btn-row' },
            h('button', {
                class: 'small',
                onClick: (event) => {
                    if (selectedMappings.size === mappings.length) selectedMappings = new Set();
                    else selectedMappings = new Set(mappings.map((row) => row.id));
                    refreshSelectionUI(event?.target);
                    viewMappings(document.getElementById('main'));
                },
            }, selectedMappings.size === mappings.length ? '取消全选' : '全选'),
            h('button', { class: 'small primary', onClick: () => batch('start') }, '批量启动'),
            h('button', { class: 'small', onClick: () => batch('stop') }, '批量停止')));
    return bar;
}

function refreshSelectionUI() {
    // Selection lives in `selectedMappings`; the table is re-rendered after a change,
    // so there is nothing to patch in place. Kept as a named hook for clarity.
}

function mappingRow(mapping, { canEdit }) {
    const running = mapping.state === 'running';
    const selected = selectedMappings.has(mapping.id);
    const checkbox = canEdit
        ? h('td', {},
            h('input', {
                type: 'checkbox',
                checked: selected,
                onChange: (event) => {
                    if (event.target.checked) selectedMappings.add(mapping.id);
                    else selectedMappings.delete(mapping.id);
                },
            }))
        : null;

    const actions = h('td', { class: 'actions' },
        canEdit
            ? h('button', {
                class: 'small',
                onClick: () => mappingAction(mapping, running ? 'stop' : 'start'),
                'data-state': running ? 'stop' : 'start',
            }, running ? '停止' : '启动')
            : null,
        h('button', { class: 'small', onClick: () => openLog(mapping) }, '日志'),
        canEdit ? h('button', { class: 'small', onClick: () => openMappingDialog(mapping) }, '编辑') : null,
        canEdit
            ? h('button', {
                class: 'small danger',
                onClick: async () => {
                    if (!confirm(`确定要删除映射“${mapping.name}”吗？`)) return;
                    try {
                        await api(`/api/mappings/${mapping.id}`, { method: 'DELETE' });
                        toast('映射已删除');
                        await viewMappings(document.getElementById('main'));
                    } catch (error) {
                        fail(error);
                    }
                },
            }, '删除')
            : null);

    return h('tr', {},
        checkbox,
        h('td', { style: 'font-weight:600' }, mapping.name),
        h('td', { class: 'num mono' }, String(mapping.localPort)),
        h('td', { class: 'mono' }, `${mapping.targetHost}:${mapping.targetPort}`),
        h('td', {}, mapping.hasPassword ? '已设置' : h('span', { class: 'muted' }, '无')),
        h('td', {}, mapping.profile === 'legacy' ? 'legacy' : '标准'),
        h('td', {}, badgeFor(mapping.state)),
        h('td', {}, running
            ? fmtDuration(mapping.startedAt)
            : h('span', { class: 'muted' }, mapping.failure || '—')),
        actions);
}

async function mappingAction(mapping, action) {
    try {
        await api(`/api/mappings/${mapping.id}/${action}`, { method: 'POST' });
        toast(action === 'start' ? '已启动' : '已停止');
    } catch (error) {
        fail(error);
    }
    await viewMappings(document.getElementById('main'));
}

async function batch(action) {
    if (selectedMappings.size === 0) {
        toast('请先选择要操作的映射', 'warn');
        return;
    }
    const ids = [...selectedMappings];
    try {
        const result = await api(`/api/mappings/batch/${action}`, { method: 'POST', body: { ids } });
        const text = `${action === 'start' ? '启动' : '停止'}成功 ${result.succeeded} 个，失败 ${result.failed} 个`;
        toast(text, result.failed > 0 ? 'warn' : 'success');
        if (result.failed > 0) showBatchErrors(action, result);
    } catch (error) {
        fail(error);
    }
    await viewMappings(document.getElementById('main'));
}

/** Show which rows failed and why, instead of only a count. */
function showBatchErrors(action, result) {
    const failed = result.results.filter((item) => !item.ok);
    const list = h('ul', { style: 'margin:8px 0 0 18px' },
        ...failed.slice(0, 10).map((item) => h('li', {},
            `${item.name ?? `#${item.id}`}：${item.error ?? '未知原因'}`)));
    const notice = h('div', { class: 'notice warn' },
        h('strong', {}, `批量${action === 'start' ? '启动' : '停止'}有 ${failed.length} 个映射失败`),
        list);
    const main = document.getElementById('main');
    if (main) main.prepend(notice);
}

function openMappingDialog(mapping) {
    const editing = Boolean(mapping);
    const name = h('input', {
        type: 'text', value: mapping?.name ?? '', maxlength: 64, placeholder: '留空则按端口自动命名',
    });
    const localPort = h('input', {
        type: 'number', value: mapping?.localPort ?? '', min: 1, max: 65535,
        placeholder: '留空则自动从端口池分配',
    });
    const targetHost = h('input', {
        type: 'text', value: mapping?.targetHost ?? '', required: true,
        placeholder: '例如 1.2.3.4 或 room.example.com（不要带端口）',
    });
    const targetPort = h('input', {
        type: 'number', value: mapping?.targetPort ?? '', min: 1, max: 65535, required: true,
        placeholder: '目标服务器自己的端口，例如 24872 或 9901',
    });
    const password = h('input', {
        type: 'password', value: '',
        placeholder: mapping?.hasPassword ? '已设置，留空表示不修改' : '可留空',
        autocomplete: 'new-password',
    });
    const profile = h('select', {},
        h('option', { value: 'default' }, '标准（完整翻译）'),
        h('option', { value: 'legacy' }, 'legacy（仅数据面）'));
    profile.value = mapping?.profile === 'legacy' ? 'legacy' : 'default';
    const capacity = h('input', { type: 'number', value: mapping?.capacity ?? 4, min: 1, max: 64 });
    const notes = h('textarea', { placeholder: '可选，例如负责的公会' }, mapping?.notes ?? '');
    const errorBox = h('div', { hidden: true });

    const submit = h('button', {
        class: 'primary',
        onClick: async (event) => {
            event.preventDefault();
            const body = {
                name: name.value.trim(),
                targetHost: targetHost.value.trim(),
                targetPort: targetPort.value,
                profile: profile.value,
                capacity: capacity.value,
                notes: notes.value,
            };
            // Only send the port when it was typed; an empty field means "allocate one"
            // on create, and "leave it alone" on edit.
            if (String(localPort.value).trim() !== '') body.localPort = localPort.value;
            if (String(password.value) !== '') body.password = password.value;
            submit.disabled = true;
            try {
                if (editing) await api(`/api/mappings/${mapping.id}`, { method: 'PATCH', body });
                else await api('/api/mappings', { method: 'POST', body });
                dialog.close();
                dialog.remove();
                toast(editing ? '映射已保存' : '映射已添加');
                await viewMappings(document.getElementById('main'));
            } catch (error) {
                errorBox.hidden = false;
                errorBox.className = 'notice error';
                errorBox.replaceChildren(h('p', {}, error?.message ?? '保存失败'));
                submit.disabled = false;
            }
        },
    }, editing ? '保存' : '添加');

    const dialog = h('dialog', { class: 'dialog' },
        h('form', { method: 'dialog', onSubmit: (event) => event.preventDefault() },
            h('div', { class: 'dialog-head' }, h('h2', {}, editing ? `编辑映射 ${mapping.name}` : '新建端口映射')),
            errorBox,
            h('div', { class: 'field' }, h('label', {}, '名称'), name),
            h('div', { class: 'field-row' },
                h('div', { class: 'field' }, h('label', {}, '本地端口'), localPort,
                    h('span', { class: 'sub' }, '玩家连这个 UDP 端口；留空则自动分配')),
                h('div', { class: 'field' }, h('label', {}, '目标端口'), targetPort,
                    h('span', { class: 'sub' }, '房间服务器自己的端口'))),
            h('div', { class: 'field' }, h('label', {}, '目标服务器地址'), targetHost,
                h('span', { class: 'sub' }, 'IPv4 或域名，不要带端口')),
            h('div', { class: 'field' }, h('label', {}, '房间密码'), password),
            h('div', { class: 'field-row' },
                h('div', { class: 'field' }, h('label', {}, '配置档'), profile),
                h('div', { class: 'field' }, h('label', {}, '房间容量'), capacity)),
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

async function openLog(mapping) {
    const dialog = h('dialog', { class: 'dialog wide' },
        h('div', { class: 'dialog-head' },
            h('h2', {}, `${mapping.name} 的日志`),
            h('p', { class: 'hint' }, `本地 ${mapping.localPort} → ${mapping.targetHost}:${mapping.targetPort}`)));
    const pre = h('pre', { class: 'log-view' }, '加载中…');
    const actions = h('div', { class: 'dialog-actions' },
        h('button', {
            type: 'button',
            onClick: async () => {
                try {
                    const log = await api(`/api/mappings/${mapping.id}/log?lines=400`);
                    pre.textContent = log.text || '（日志为空）';
                } catch (error) {
                    fail(error);
                }
            },
        }, '刷新'),
        h('button', { type: 'button', class: 'primary', onClick: () => { dialog.close(); dialog.remove(); } }, '关闭'));
    dialog.append(pre, actions);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    try {
        const log = await api(`/api/mappings/${mapping.id}/log?lines=400`);
        pre.textContent = log.text || '（日志为空：该映射可能从未启动过）';
    } catch (error) {
        pre.textContent = `读取日志失败：${error?.message ?? error}`;
    }
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

    const rows = users.map((user) => {
        const status = user.disabled
            ? h('span', { class: 'badge failed' }, '已禁用')
            : user.lockedUntil && user.lockedUntil > Date.now()
                ? h('span', { class: 'badge failed' }, '锁定中')
                : h('span', { class: 'badge running' }, '正常');
        const actions = user.role === 'owner'
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
            }, '删除');
        return h('tr', {},
            h('td', { style: 'font-weight:600' }, user.username),
            h('td', {}, roleLabel(user.role)),
            h('td', { class: 'nowrap' }, fmtTime(user.lastLoginAt)),
            h('td', { class: 'nowrap' }, fmtTime(user.createdAt)),
            h('td', {}, status),
            h('td', { class: 'actions' }, actions));
    });

    const table = h('table', { style: 'min-width:620px' },
        h('thead', {}, h('tr', {},
            h('th', {}, '账户'), h('th', {}, '角色'), h('th', {}, '最近登录'),
            h('th', {}, '创建时间'), h('th', {}, '状态'), h('th', {}, '操作'))),
        h('tbody', {}, rows));
    main.replaceChildren(h('section', { class: 'card' }, head,
        h('div', { class: 'table-wrap' }, table)));
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
            ['本地端口池', `${diagnostics.localPortRange[0]} - ${diagnostics.localPortRange[1]}（已用 ${diagnostics.usedLocalPorts.length}）`],
            ['运行目录', diagnostics.runtimeDir],
            ['采样间隔', `${diagnostics.sampleIntervalMs} ms`],
            ['运行环境', `${diagnostics.platform} · Node ${diagnostics.nodeVersion}`],
            ['已运行', fmtDuration(Date.now() - diagnostics.uptimeSeconds * 1000)],
        ];
        const infoRows = rows.map(([label, value]) => h('tr', {},
            h('td', { style: 'width:150px;color:var(--muted)' }, label),
            h('td', { class: 'mono' }, value === undefined || value === null ? '—' : String(value))));
        const infoTable = h('table', { style: 'min-width:520px' }, h('tbody', {}, infoRows));
        blocks.push(h('section', { class: 'card' },
            h('div', { class: 'card-head' },
                h('div', {}, h('h2', {}, '部署信息'),
                    h('p', { class: 'hint' }, '只读。要修改端口池、数据源或网关路径，请编辑 config.json 后重启服务。'))),
            h('div', { class: 'table-wrap' }, infoTable)));
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
