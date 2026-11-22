#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Container entrypoint.
#
# Jobs, in order:
#   1. Make the data volume usable by the unprivileged runtime user. A bind mount
#      from the host arrives owned by root, and `node` then cannot write the
#      database or the room logs. Running as root just long enough to fix
#      ownership is the standard trade-off; the process drops back to `node`
#      before the console starts.
#   2. Explain the gateway binary situation honestly instead of failing later with
#      "找不到 citra-gateway" only when someone clicks Start.
#
# Nothing here parses secrets: the console reads its own config through
# src/lib/config.js, and passwords never appear in this script's output.

set -eu

DATA_DIR="${MHGA_DATA_DIR:-/data}"
APP_DIR="/app"

log() {
    # Keep the same JSON-ish shape as the application logger so `docker logs`
    # output is uniform.
    printf '{"time":"%s","level":"info","message":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

warn() {
    printf '{"time":"%s","level":"warn","message":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

# ---- 1. Data volume ownership ---------------------------------------------
if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_DIR" "$DATA_DIR/rooms"
    if [ "${MHGA_SKIP_CHOWN:-0}" != "1" ]; then
        # Only chown when something is actually misowned, so a large volume does
        # not get walked on every restart.
        if [ "$(stat -c '%U' "$DATA_DIR" 2>/dev/null || echo root)" != "node" ]; then
            log "fixing ownership of $DATA_DIR for the node user"
            chown -R node:node "$DATA_DIR" 2>/dev/null || warn "could not chown $DATA_DIR; the console may not be able to write"
        fi
    fi
    log "dropping privileges to the node user"
    exec setpriv --reuid=node --regid=node --clear-groups -- "$@"
fi

# ---- 2. Gateway binary availability ---------------------------------------
if [ -z "${MHGA_GATEWAY_BIN:-}" ]; then
    if [ -x "$APP_DIR/bin/citra-gateway" ]; then
        export MHGA_GATEWAY_BIN="$APP_DIR/bin/citra-gateway"
        log "using bundled gateway binary $MHGA_GATEWAY_BIN"
    elif command -v citra-gateway >/dev/null 2>&1; then
        log "using citra-gateway from PATH"
    else
        warn "no citra-gateway found in /app/bin or PATH: the console will start and rooms can be created, but Start will refuse until a gateway binary is mounted into /app/bin"
    fi
fi

mkdir -p "${MHGA_RUNTIME_DIR:-$DATA_DIR/rooms}" 2>/dev/null || true

log "starting mhg-gateway-admin"
exec "$@"
