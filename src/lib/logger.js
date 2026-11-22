// SPDX-License-Identifier: GPL-3.0-or-later
// Structured logging with a level gate. A file sink is optional; stdout is the
// default so systemd / docker logs capture everything.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', file = '' } = {}) {
    const gate = LEVELS[level] ?? LEVELS.info;
    if (file) mkdirSync(dirname(file), { recursive: true });

    const write = (lvl, message, fields) => {
        if (LEVELS[lvl] < gate) return;
        const record = {
            time: new Date().toISOString(),
            level: lvl,
            message,
        };
        if (fields !== undefined) record.fields = fields;
        const line = `${JSON.stringify(record)}\n`;
        if (file) {
            try {
                appendFileSync(file, line, 'utf8');
            } catch {
                // A broken log sink must never break the request path.
                process.stdout.write(line);
            }
        } else {
            process.stdout.write(line);
        }
    };

    return {
        level,
        debug: (message, fields) => write('debug', message, fields),
        info: (message, fields) => write('info', message, fields),
        warn: (message, fields) => write('warn', message, fields),
        error: (message, fields) => write('error', message, fields),
        child: (prefix) => {
            const wrap = (fn) => (message, fields) =>
                fn(`${prefix} ${message}`, fields);
            return {
                level,
                debug: wrap(write.bind(null, 'debug')),
                info: wrap(write.bind(null, 'info')),
                warn: wrap(write.bind(null, 'warn')),
                error: wrap(write.bind(null, 'error')),
            };
        },
    };
}
