#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Entry point: parse arguments, load config, open the datasource, start the
// supervisor and the HTTP server, and shut everything down cleanly on a signal.

import { existsSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig, ConfigError, defaultConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { createDatasource } from './datasource/factory.js';
import { GatewaySupervisor } from './lib/supervisor.js';
import { createApp } from './app.js';
import { randomToken } from './lib/tokens.js';

const VERSION = '0.1.0';

function usage() {
    process.stdout.write(`mhg-gateway-admin ${VERSION} — MHXX/MHGU 网关服务器批量管理控制台

用法:
  mhg-gateway-admin [选项]

选项:
  --config <path>    配置文件路径 (默认 ./config.json，缺失则使用内置默认值)
  --print-config     打印生效配置（密码字段已隐藏）后退出
  --init-config      在配置文件路径写出一个默认 config.json 后退出
  --check            加载配置、打开数据源、自检后退出（用于部署前验证）
  --host <addr>      覆盖监听地址
  --port <n>         覆盖监听端口
  --help             显示本帮助
  --version          显示版本

环境变量:
  MHGA_CONFIG, MHGA_HOST, MHGA_PORT, MHGA_PUBLIC_URL, MHGA_TRUST_PROXY,
  MHGA_DB_DRIVER, MHGA_SQLITE_PATH, MHGA_MYSQL_HOST, MHGA_MYSQL_PORT,
  MHGA_MYSQL_USER, MHGA_MYSQL_PASSWORD, MHGA_MYSQL_DATABASE,
  MHGA_MYSQL_TABLE_PREFIX, MHGA_GATEWAY_BIN, MHGA_RUNTIME_DIR,
  MHGA_LOG_LEVEL, MHGA_LOG_FILE
`);
}

function parseArgs(argv) {
    const args = { config: null, printConfig: false, initConfig: false, check: false, host: null, port: null };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined) throw new Error(`${arg} 缺少参数值`);
            index += 1;
            return value;
        };
        switch (arg) {
        case '--config':
            args.config = next();
            break;
        case '--print-config':
            args.printConfig = true;
            break;
        case '--init-config':
            args.initConfig = true;
            break;
        case '--check':
            args.check = true;
            break;
        case '--host':
            args.host = next();
            break;
        case '--port':
            args.port = Number(next());
            break;
        case '--help':
        case '-h':
            args.help = true;
            break;
        case '--version':
        case '-v':
            args.version = true;
            break;
        default:
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return args;
}

/** Hide secrets before anything reaches a terminal or a log file. */
function redactForPrint(config) {
    const clone = JSON.parse(JSON.stringify(config, (key, value) => {
        if (typeof value === 'string' && ['password'].includes(key)) return value ? '***' : '';
        return value;
    }));
    return clone;
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        usage();
        return 2;
    }
    if (args.help) {
        usage();
        return 0;
    }
    if (args.version) {
        process.stdout.write(`${VERSION}\n`);
        return 0;
    }

    const root = process.cwd();

    if (args.initConfig) {
        const target = resolve(root, args.config ?? 'config.json');
        if (existsSync(target)) {
            process.stderr.write(`配置文件已存在，未覆盖: ${target}\n`);
            return 1;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${JSON.stringify(defaultConfig(), null, 2)}\n`, 'utf8');
        process.stdout.write(`已写出默认配置: ${target}\n`);
        return 0;
    }

    let config;
    try {
        config = loadConfig({ file: args.config ? resolve(root, args.config) : null, root });
    } catch (error) {
        if (error instanceof ConfigError) {
            process.stderr.write(`配置错误: ${error.message}\n`);
            return 2;
        }
        throw error;
    }
    if (args.host) config.server.host = args.host;
    if (Number.isInteger(args.port) && args.port > 0 && args.port <= 65535) config.server.port = args.port;
    config.version = VERSION;

    const logger = createLogger({ level: config.logging.level, file: config.logging.file });

    if (args.printConfig) {
        process.stdout.write(`${JSON.stringify(redactForPrint(config), null, 2)}\n`);
        return 0;
    }

    // Session signing material. Generated on first run and persisted so sessions
    // survive a restart; this is the one secret the console owns.
    ensureSessionSecret(config, logger);

    let datasource;
    try {
        datasource = createDatasource(config);
        await datasource.init();
        await datasource.ping();
    } catch (error) {
        if (error.code === 'MYSQL2_MISSING') {
            process.stderr.write(`${error.message}\n`);
        } else {
            process.stderr.write(`数据源初始化失败: ${error.message}\n`);
        }
        return 3;
    }

    const supervisor = new GatewaySupervisor({ config, datasource, logger });
    await supervisor.start();

    if (args.check) {
        const rooms = await datasource.listRooms();
        const users = await datasource.countUsers();
        const binary = supervisor.probeBinary();
        process.stdout.write([
            '自检通过',
            `  数据源: ${datasource.driver}`,
            `  配置文件: ${config.configPath ?? '(使用默认值)'}`,
            `  监听: ${config.server.host}:${config.server.port}`,
            `  管理员: ${users > 0 ? '已初始化' : '尚未初始化 (首次打开网页时设置)'}`,
            `  房间: ${rooms.length}`,
            `  网关程序: ${binary ?? `未找到 — ${supervisor.binaryError}`}`,
            `  运行目录: ${config.gateways.runtimeDir}`,
            '',
        ].join('\n'));
        await supervisor.stop();
        await datasource.close();
        return 0;
    }

    const { server } = createApp({ config, datasource, supervisor, logger });

    await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
            if (error.code === 'EADDRINUSE') {
                rejectListen(new Error(`监听端口 ${config.server.port} 已被占用`));
                return;
            }
            if (error.code === 'EACCES') {
                rejectListen(new Error(`没有权限监听 ${config.server.host}:${config.server.port}`));
                return;
            }
            rejectListen(error);
        };
        server.once('error', onError);
        server.listen(config.server.port, config.server.host, () => {
            server.removeListener('error', onError);
            resolveListen();
        });
    }).catch(async (error) => {
        process.stderr.write(`启动失败: ${error.message}\n`);
        await supervisor.stop();
        await datasource.close();
        process.exitCode = 3;
        throw error;
    });

    const address = server.address();
    const shown = typeof address === 'object' && address ? address.port : config.server.port;
    const hostForUrl = ['0.0.0.0', '::', ''].includes(config.server.host) ? '127.0.0.1' : config.server.host;
    const users = await datasource.countUsers();
    logger.info('listening', {
        host: config.server.host,
        port: shown,
        url: config.server.publicUrl || `http://${hostForUrl}:${shown}`,
        datasource: datasource.driver,
        setupComplete: users > 0,
    });
    process.stdout.write(
        `\n  MHXX/MHGU 网关管理控制台已启动\n` +
        `  访问地址: ${config.server.publicUrl || `http://${hostForUrl}:${shown}`}\n` +
        `  数据源:   ${datasource.driver}\n` +
        (users > 0
            ? ''
            : '  首次使用: 打开页面后按提示创建管理员账户\n') +
        (supervisor.binary ? '' : `  注意:     ${supervisor.binaryError}\n`) +
        '\n',
    );

    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info('shutting down', { signal });
        const forceTimer = setTimeout(() => process.exit(1), 15_000);
        forceTimer.unref?.();
        try {
            await new Promise((resolveClose) => server.close(resolveClose));
            await supervisor.stop();
            await datasource.close();
        } catch (error) {
            logger.error('shutdown error', { error: error.message });
        } finally {
            clearTimeout(forceTimer);
            process.exit(0);
        }
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            shutdown(signal).catch(() => process.exit(1));
        });
    }
    process.on('unhandledRejection', (reason) => {
        logger.error('unhandled rejection', { reason: String(reason) });
    });
    return null;
}

/**
 * Create the session secret file if absent. It is not currently used to sign
 * cookies (sessions are opaque random ids looked up by hash), but it is the
 * stable place to keep per-deployment secrets and it makes "delete this file to
 * rotate" a documented operation.
 */
function ensureSessionSecret(config, logger) {
    const path = config.auth.secretFile;
    try {
        if (existsSync(path)) {
            const text = readFileSync(path, 'utf8').trim();
            if (text.length >= 32) return text;
        }
        mkdirSync(dirname(path), { recursive: true });
        const secret = randomToken(48);
        writeFileSync(path, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
        try {
            chmodSync(path, 0o600);
        } catch { /* Windows: not applicable */ }
        logger.info('generated session secret', { path });
        return secret;
    } catch (error) {
        logger.warn('could not persist session secret', { path, error: error.message });
        return null;
    }
}

main().then((code) => {
    if (typeof code === 'number') process.exit(code);
}).catch((error) => {
    process.stderr.write(`致命错误: ${error?.stack ?? error}\n`);
    process.exit(1);
});
