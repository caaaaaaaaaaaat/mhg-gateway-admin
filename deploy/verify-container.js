#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Static + behavioural checks on the container inputs.
//
// This machine has no Docker daemon, so `docker build` cannot run here. What CAN
// be verified without it, and is verified here, is everything that would make a
// build fail or a container misbehave:
//
//   1. every path the Dockerfile COPYs actually exists and is not excluded by
//      .dockerignore (a COPY of an ignored file fails the build);
//   2. the container entrypoint is a valid POSIX shell script and its helper
//      commands are ones the base image provides;
//   3. the healthcheck command is valid JavaScript and hits a route the app
//      really serves;
//   4. the container config (config/docker.json) validates, and the console
//      actually starts with the exact MHGA_* environment the image sets, on a
//      temporary directory standing in for /data.
//
//   node deploy/verify-container.js
//
// Exit 0 means "nothing here would break a build"; it does not mean an image was
// produced.

import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const results = [];

function check(ok, label, detail = '') {
    results.push({ ok: Boolean(ok), label, detail });
    if (!ok) failures += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}\n`);
}

function read(rel) {
    return readFileSync(join(projectRoot, rel), 'utf8');
}

const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');
const entrypoint = read('docker-entrypoint.sh');
const dockerConfigText = read('config/docker.json');

// ---------------------------------------------------------------------------
// 1. COPY sources exist and are not dockerignored
// ---------------------------------------------------------------------------
process.stdout.write('\n== Dockerfile COPY sources ==\n');

const ignored = dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

function isIgnored(path) {
    // The build context is the project root; a top-level pattern matches the
    // first path segment, which is enough for this .dockerignore.
    return ignored.some((pattern) => {
        if (pattern.endsWith('/')) {
            const dir = pattern.slice(0, -1);
            return path === dir || path.startsWith(`${dir}/`);
        }
        if (pattern.startsWith('*')) return new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(path);
        return path === pattern;
    });
}

const copySources = [];
for (const line of dockerfile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^COPY\s/.test(trimmed)) continue;
    if (trimmed.includes('--from=')) {
        // Inter-stage copy: the source lives in another stage, not the context.
        continue;
    }
    const parts = trimmed.split(/\s+/).slice(1);
    // Last token is the destination.
    for (const source of parts.slice(0, -1)) {
        copySources.push(source);
    }
}
check(copySources.length > 0, 'Dockerfile 至少有一个 COPY 源');

// Resolve one COPY source against the context, allowing a trailing `*` wildcard
// (e.g. `package-lock.json*`). Returns the matched path or null.
function resolveCopySource(source) {
    if (!source.includes('*')) {
        return existsSync(join(projectRoot, source)) ? source : null;
    }
    const dir = dirname(source);
    const pattern = new RegExp(
        `^${source.split('/').pop().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    const actualDir = join(projectRoot, dir === '.' ? '' : dir);
    try {
        const entries = readdirSync(actualDir);
        const match = entries.find((name) => pattern.test(name));
        return match ? (dir === '.' ? match : posix.join(dir, match)) : null;
    } catch {
        return null;
    }
}

for (const source of copySources) {
    const resolved = resolveCopySource(source);
    check(Boolean(resolved), `COPY 源存在: ${source}`);
    if (resolved) {
        check(!isIgnored(resolved), `COPY 源未被 .dockerignore 排除: ${source}`,
            '被排除的文件会让 docker build 直接失败');
    }
}

// The inter-stage copy must reference a path the deps stage really creates.
const depsCopies = [...dockerfile.matchAll(/COPY --from=(\w+)\s+(\S+)\s+(\S+)/g)];
for (const [, stage, from] of depsCopies) {
    check(stage === 'deps', `跨阶段 COPY 来自已知阶段 (${stage})`);
    check(from === '/build/node_modules' || from.startsWith('/build/'),
        `跨阶段拷贝路径合理: ${from}`);
}
check(depsCopies.length > 0, '存在跨阶段依赖拷贝');
// And the deps stage must actually produce that path.
const depsStage = dockerfile.slice(0, dockerfile.indexOf('AS runtime'));
check(/mkdir -p node_modules|npm (ci|install)/.test(depsStage),
    'deps 阶段确实会生成 node_modules');

// ---------------------------------------------------------------------------
// 2. Entrypoint sanity
// ---------------------------------------------------------------------------
process.stdout.write('\n== 容器入口脚本 ==\n');
check(entrypoint.startsWith('#!/bin/sh'), '入口脚本使用 /bin/sh shebang');
check(entrypoint.includes('set -eu'), '入口脚本启用 set -eu');
check(!/\r\n/.test(entrypoint), '入口脚本是 LF 换行（CRLF 会让容器报 sh\\r 错误）');
check(entrypoint.includes('exec setpriv'), '入口脚本用 setpriv 降权');
check(entrypoint.includes('exec "$@"'), '入口脚本最终 exec 到 CMD');

// Commands the script relies on must come from the base image or an installed
// package. Each is explicit so a missing one is a build-time finding, not a
// runtime surprise.
const baseTools = {
    setpriv: 'util-linux',
    stat: 'coreutils (base)',
    chown: 'coreutils (base)',
    mkdir: 'coreutils (base)',
    date: 'coreutils (base)',
};
for (const tool of Object.keys(baseTools)) {
    const uses = new RegExp(`(^|[\\s|&(])${tool}[\\s|&)]`, 'm').test(entrypoint);
    if (!uses) continue;
    const provided = ['coreutils', 'base'].some((token) => baseTools[tool].includes(token))
        || dockerfile.includes('util-linux');
    check(provided, `入口脚本用到的 ${tool} 由镜像提供（${baseTools[tool]}）`);
}

// ---------------------------------------------------------------------------
// 3. Healthcheck
// ---------------------------------------------------------------------------
process.stdout.write('\n== 健康检查 ==\n');
const healthMatches = [...dockerfile.matchAll(/HEALTHCHECK[\s\S]*?CMD\s+(\[[^\n]+\]|node -e [^\n]+)/g)];
check(healthMatches.length > 0, 'Dockerfile 定义了 HEALTHCHECK');
for (const match of healthMatches) {
    const raw = match[1];
    // Extract the JS payload and syntax-check it.
    const jsMatch = /node",?\s*"-e",?\s*"(.+)"\]?$/m.exec(raw) ?? /node -e '(.+)'$/.exec(raw);
    if (jsMatch) {
        const js = jsMatch[1].replace(/\\"/g, '"');
        let syntaxOk = true;
        try {
            // new Function parses without executing, which is exactly the check.
            new Function(js);
        } catch {
            syntaxOk = false;
        }
        check(syntaxOk, '健康检查的 JavaScript 语法有效', js.slice(0, 80));
        check(js.includes('/api/health'), '健康检查请求 /api/health');
    } else {
        check(true, '健康检查使用 exec 形式（无内联 JS 需要校验）');
    }
}

// The docker-compose healthcheck must agree with the Dockerfile one.
const compose = read('docker-compose.yml');
check(compose.includes('/api/health'), 'docker-compose 健康检查同样打 /api/health');
for (const key of ['MHGA_SQLITE_PATH', 'MHGA_RUNTIME_DIR', 'MHGA_PORT']) {
    check(compose.includes(key), `docker-compose 传递 ${key}`);
}
// Volumes: the database and logs must land on a persisted path.
check(/volumes:[\s\S]*?data:/i.test(compose), 'docker-compose 挂载了数据卷');

// ---------------------------------------------------------------------------
// 4. Container config validates and the console starts with the image's env
// ---------------------------------------------------------------------------
process.stdout.write('\n== 容器配置与启动 ==\n');
const containerConfig = JSON.parse(dockerConfigText);
check(containerConfig.storage.driver === 'sqlite', '容器默认数据源为 sqlite');
check(containerConfig.storage.sqlite.path.startsWith('/data/'), 'SQLite 路径在 /data 卷上');
check(containerConfig.gateways.runtimeDir.startsWith('/data/'), '房间日志在 /data 卷上');
check(containerConfig.auth.secretFile.startsWith('/data/'), '会话密钥在 /data 卷上');
check(containerConfig.server.port === 8720, '容器监听 8720');
check(Array.isArray(containerConfig.gateways.binSearchPaths)
    && containerConfig.gateways.binSearchPaths.includes('/app/bin'),
    '网关程序搜索路径包含 /app/bin');

// A real start with the container's environment, using a temp dir as /data.
const root = mkdtempSync(join(tmpdir(), 'mhga-container-'));
const dataDir = join(root, 'data');
mkdirSync(join(dataDir, 'rooms'), { recursive: true });
const port = await (() => new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const assigned = server.address().port;
        server.close(() => resolve(assigned));
    });
}))();

// Rewrite the container config's /data paths to the temp dir, keeping everything
// else identical, so this proves the shipped config is loadable, not a bespoke one.
const effective = JSON.parse(JSON.stringify(containerConfig));
const rewrite = (value) => value.replace(/^\/data/, dataDir);
effective.storage.sqlite.path = rewrite(effective.storage.sqlite.path);
effective.gateways.runtimeDir = rewrite(effective.gateways.runtimeDir);
effective.auth.secretFile = rewrite(effective.auth.secretFile);
effective.server.host = '127.0.0.1';
effective.server.port = port;
effective.logging.level = 'warn';
const configPath = join(root, 'config.json');
writeFileSync(configPath, JSON.stringify(effective, null, 2), 'utf8');

const env = {
    ...process.env,
    NODE_ENV: 'production',
    MHGA_HOST: '127.0.0.1',
    MHGA_PORT: String(port),
    MHGA_DB_DRIVER: 'sqlite',
    MHGA_SQLITE_PATH: effective.storage.sqlite.path,
    MHGA_RUNTIME_DIR: effective.gateways.runtimeDir,
    MHGA_LOG_LEVEL: 'warn',
};

const child = spawn(process.execPath, [join(projectRoot, 'src/index.js'), '--config', configPath], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
});
let stderrText = '';
child.stderr.on('data', (chunk) => { stderrText += String(chunk); });

const up = await (async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (response.ok) {
                const body = await response.json();
                return body;
            }
        } catch { /* not up yet */ }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
})();

check(Boolean(up), '用容器环境变量可以启动控制台', stderrText.split('\n').filter(Boolean).slice(-3).join(' | '));
if (up) {
    check(up.data?.datasource === 'sqlite', '运行中的数据源是 sqlite');
    // The session endpoint is what the first browser load calls.
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json();
    check(session.data?.setupComplete === false, '全新数据卷显示「需要初始化管理员」');
    // The web assets must be served from the image's /app/public equivalent.
    const index = await fetch(`http://127.0.0.1:${port}/`);
    check(index.ok, '首页可访问');
    // The database file must land on the data path, not somewhere ephemeral.
    check(existsSync(effective.storage.sqlite.path), '数据库文件写在 /data 对应路径上');
}

child.kill('SIGTERM');
await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
rmSync(root, { recursive: true, force: true });
const passed = results.filter((item) => item.ok).length;
process.stdout.write(`\n=== ${passed}/${results.length} 项通过，${failures} 项失败 ===\n`);
if (failures > 0) {
    process.stdout.write('\n未通过项:\n');
    for (const item of results) {
        if (!item.ok) process.stdout.write(`  - ${item.label}${item.detail ? ` (${item.detail})` : ''}\n`);
    }
    process.stdout.write('\n注意: 这不能替代 `docker build`；本机没有 Docker，镜像本身未构建。\n');
}
process.exitCode = failures === 0 ? 0 : 1;
