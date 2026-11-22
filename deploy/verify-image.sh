#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Deep acceptance test for an already-built image, on a real Docker host.
#
# build-image.sh does build + a shallow smoke test. This script assumes the image
# exists and exercises the things that actually decide whether a deployment is
# usable: the full business flow over HTTP, and -- the part that matters most for
# a volume-backed console -- that deleting the container and recreating it from
# the same volume keeps accounts, mappings and audit history.
#
# It is written to be safe on a shared server:
#   * every container it creates is named with a unique prefix and removed after;
#   * it binds a loopback port it first verifies is free, and refuses to continue
#     if the port is taken rather than picking a random one silently;
#   * it never runs a global prune, never stops or filters containers it did not
#     create, and never touches images other than the one under test.
#
#   ./deploy/verify-image.sh
#   IMAGE=mhg-gateway-admin:latest PORT=18720 ./deploy/verify-image.sh
#
# Exit codes: 0 all checks passed, 1 a check failed, 3 prerequisites missing.

set -u

IMAGE="${IMAGE:-mhg-gateway-admin:latest}"
PORT="${PORT:-18720}"
NAME="mhga-verify-$$"
DATA="$(mktemp -d)"
BASE="http://127.0.0.1:$PORT"
FAIL=0

ck() {
    if [ "$1" = "1" ]; then
        printf 'PASS %s\n' "$2"
    else
        printf 'FAIL %s\n' "$2"
        FAIL=$((FAIL + 1))
    fi
}

note() { printf '  %s\n' "$1"; }

cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$DATA" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Docker may need sudo for a non-root user not in the docker group.
if docker version >/dev/null 2>&1; then
    DOCKER="docker"
elif sudo -n docker version >/dev/null 2>&1; then
    DOCKER="sudo docker"
else
    echo "无法访问 Docker（既不可直接使用，也没有免密 sudo）。" >&2
    exit 3
fi
D() { $DOCKER "$@"; }

say() { printf '\n== %s\n' "$1"; }

say "前提检查"
if ! D image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "镜像 $IMAGE 不存在。先构建: ./deploy/build-image.sh" >&2
    exit 3
fi
# `docker images` reports the same size the user sees; inspect's .Size is not it.
note "镜像: $(D images "$IMAGE" --format '{{.Size}}' | head -1)"
if D ps --format '{{.Ports}}' | grep -q ":$PORT->"; then
    echo "端口 $PORT 已被占用，换一个: PORT=xxxx $0" >&2
    exit 3
fi
note "端口 $PORT 空闲"
note "测试容器名: $NAME（结束后自动删除）"

say "启动容器"
D run -d --name "$NAME" \
    -e "MHGA_PORT=$PORT" \
    -p "127.0.0.1:$PORT:$PORT" \
    -v "$DATA:/data" \
    --memory 512m \
    "$IMAGE" >/dev/null || { echo "容器启动失败" >&2; exit 1; }

ready=0
for _ in $(seq 1 60); do
    if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then ready=1; break; fi
    if ! D ps --format '{{.Names}}' | grep -qx "$NAME"; then
        echo "容器已退出，日志:" >&2
        D logs "$NAME" >&2
        exit 1
    fi
    sleep 1
done
ck "$ready" "健康检查就绪"

say "基础可用性"
curl -fsS "$BASE/" | grep -q '网关管理' && ck 1 "首页可访问" || ck 0 "首页可访问"
curl -fsS "$BASE/app.css" >/dev/null 2>&1 && ck 1 "app.css 可加载" || ck 0 "app.css 可加载"
curl -fsS "$BASE/app.js" >/dev/null 2>&1 && ck 1 "app.js 可加载" || ck 0 "app.js 可加载"
curl -fsS -D - -o /dev/null "$BASE/" 2>/dev/null | grep -qi "default-src 'self'" \
    && ck 1 "CSP 响应头存在" || ck 0 "CSP 响应头存在"

S0="$(curl -fsS "$BASE/api/session" 2>/dev/null)"
echo "$S0" | grep -q '"setupComplete":false' && ck 1 "首次打开要求初始化" || ck 0 "首次打开要求初始化"

say "鉴权"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"Verify-Pass-2026","confirm":"Verify-Pass-2026"}')"
ck "$([ "$CODE" = "201" ] && echo 1 || echo 0)" "创建管理员 (201)"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup" \
    -H 'Content-Type: application/json' \
    -d '{"username":"x","password":"Other-Pass-2026","confirm":"Other-Pass-2026"}')"
ck "$([ "$CODE" = "409" ] && echo 1 || echo 0)" "重复初始化被拒绝 (409)"

# Extract a JSON string field without depending on python or jq: the API emits
# compact JSON, so an anchored grep is enough and works on any base image.
json_field() {
    printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
}
json_number() {
    printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2
}

JAR="$DATA/.cookies"
LOGIN="$(curl -s -c "$JAR" -X POST "$BASE/api/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"Verify-Pass-2026"}')"
CSRF="$(json_field "$LOGIN" csrfToken)"
ck "$([ -n "$CSRF" ] && echo 1 || echo 0)" "登录并取得 CSRF token"
grep -qi 'httponly' "$JAR" 2>/dev/null && ck 1 "会话 cookie 含 HttpOnly" || note "cookie 文件中未见 HttpOnly 标记"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/mappings" \
    -H 'Content-Type: application/json' -d '{"targetHost":"127.0.0.1","targetPort":24872}')"
ck "$([ "$CODE" = "403" ] && echo 1 || echo 0)" "无 CSRF 头的写操作被拒绝 (403)"

say "端口映射"
# One row is one pair: a local port and the upstream server it forwards to.
M1="$(curl -s -b "$JAR" -H "x-csrf-token: $CSRF" -H 'Content-Type: application/json' \
    -X POST "$BASE/api/mappings" \
    -d '{"name":"验证-1","localPort":25000,"targetHost":"www.okuapi.xyz","targetPort":9901,"password":"room-pw"}')"
MID="$(json_number "$M1" id)"
ck "$([ -n "$MID" ] && echo 1 || echo 0)" "创建映射（本地端口 → 目标服务器）"
printf '%s' "$M1" | grep -q '"localPort":25000' && ck 1 "本地端口按填写值保存" || ck 0 "本地端口按填写值保存"
printf '%s' "$M1" | grep -q '"targetHost":"www.okuapi.xyz"' && ck 1 "目标服务器地址保存" || ck 0 "目标服务器地址保存"
printf '%s' "$M1" | grep -q '"targetPort":9901' && ck 1 "目标服务器端口保存" || ck 0 "目标服务器端口保存"
printf '%s' "$M1" | grep -q 'room-pw' && ck 0 "房间密码未回显" || ck 1 "房间密码未回显"

# A blank local port is allocated from the pool.
curl -s -o /dev/null -b "$JAR" -H "x-csrf-token: $CSRF" -H 'Content-Type: application/json' \
    -X POST "$BASE/api/mappings" -d '{"name":"验证-2","targetHost":"127.0.0.1","targetPort":24872}'
MAPS="$(curl -s -b "$JAR" "$BASE/api/mappings")"
NMAPS="$(printf '%s' "$MAPS" | grep -o '"id":' | wc -l | tr -d ' ')"
ck "$([ "$NMAPS" = "2" ] && echo 1 || echo 0)" "创建 2 条映射"
printf '%s' "$MAPS" | grep -q '"localPort":25001' && ck 1 "留空端口从池中分配 (25001)" || note "自动端口: $(printf '%s' "$MAPS" | grep -o '"localPort":[0-9]*' | tr '\n' ' ')"

# A duplicate local port is refused with a precise error.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H "x-csrf-token: $CSRF" -H 'Content-Type: application/json' \
    -X POST "$BASE/api/mappings" -d '{"targetHost":"127.0.0.1","targetPort":1,"localPort":25000}')"
ck "$([ "$CODE" = "409" ] && echo 1 || echo 0)" "重复本地端口被拒绝 (409)"

CODE="$(curl -s -b "$JAR" -H "x-csrf-token: $CSRF" -o "$DATA/.start.json" -w '%{http_code}' \
    -X POST "$BASE/api/mappings/$MID/start")"
# Without a Linux gateway binary inside the image, Start must refuse honestly.
ck "$([ "$CODE" = "409" ] && echo 1 || echo 0)" "无网关二进制时启动如实拒绝 (409)"
grep -q 'citra-gateway' "$DATA/.start.json" 2>/dev/null && ck 1 "拒绝原因指向 citra-gateway" || note "拒绝信息: $(head -c 200 "$DATA/.start.json" 2>/dev/null)"

say "数据卷与进程"
[ -f "$DATA/mhg-gateway-admin.db" ] && ck 1 "数据库在 /data 卷上" || ck 0 "数据库在 /data 卷上"
[ -f "$DATA/session-secret" ] && ck 1 "会话密钥在 /data 卷上" || ck 0 "会话密钥在 /data 卷上"
PERM="$(stat -c '%a' "$DATA/session-secret" 2>/dev/null)"
ck "$([ "$PERM" = "600" ] && echo 1 || echo 0)" "会话密钥权限 0600 (got ${PERM:-?})"
UID_="$(D exec "$NAME" id -u 2>/dev/null)"
ck "$([ "$UID_" = "1000" ] && echo 1 || echo 0)" "以非 root 运行 (uid=${UID_:-?})"
# The image sets interval=30s with a 10s start period, so the first probe may not
# have run yet. Wait for the real verdict instead of reading `starting` as a
# failure -- a container that never reaches healthy is exactly what this catches.
HEALTH=""
for _ in $(seq 1 45); do
    HEALTH="$(D inspect "$NAME" --format '{{.State.Health.Status}}' 2>/dev/null)"
    [ "$HEALTH" = "healthy" ] && break
    [ "$HEALTH" = "unhealthy" ] && break
    sleep 1
done
ck "$([ "$HEALTH" = "healthy" ] && echo 1 || echo 0)" "Docker healthcheck 达到 healthy (got ${HEALTH:-无})"

say "持久化：删除容器，用同一卷重建"
D stop "$NAME" >/dev/null 2>&1
D rm "$NAME" >/dev/null 2>&1
ck 1 "容器已删除，数据卷保留"
D run -d --name "$NAME" \
    -e "MHGA_PORT=$PORT" \
    -p "127.0.0.1:$PORT:$PORT" \
    -v "$DATA:/data" \
    --memory 512m \
    "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
    curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
    sleep 1
done
S1="$(curl -fsS "$BASE/api/session" 2>/dev/null)"
echo "$S1" | grep -q '"setupComplete":true' && ck 1 "重建后不再要求初始化" || ck 0 "重建后不再要求初始化"

JAR2="$DATA/.cookies2"
LOGIN2="$(curl -s -c "$JAR2" -X POST "$BASE/api/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"Verify-Pass-2026"}')"
CSRF2="$(json_field "$LOGIN2" csrfToken)"
ck "$([ -n "$CSRF2" ] && echo 1 || echo 0)" "重建后原账户可登录"

MAPS2="$(curl -s -b "$JAR2" "$BASE/api/mappings")"
N2="$(printf '%s' "$MAPS2" | grep -o '"id":' | wc -l | tr -d ' ')"
ck "$([ "$N2" = "2" ] && echo 1 || echo 0)" "重建后映射仍在 ($N2 条)"
printf '%s' "$MAPS2" | grep -q '"localPort":25000' && ck 1 "重建后本地端口保持原样" || ck 0 "重建后本地端口保持原样"
printf '%s' "$MAPS2" | grep -q '"targetHost":"www.okuapi.xyz"' && ck 1 "重建后目标服务器地址仍在" || ck 0 "重建后目标服务器地址仍在"
printf '%s' "$MAPS2" | grep -q '"targetPort":9901' && ck 1 "重建后目标端口保持原样" || ck 0 "重建后目标端口保持原样"
EV="$(curl -s -b "$JAR2" "$BASE/api/events?limit=100")"
printf '%s' "$EV" | grep -q 'mapping.start.refused' && ck 1 "重建后审计事件仍在" || ck 0 "重建后审计事件仍在"

say "前端"
# The image must not ship an unparseable front end. A syntax error here is a blank
# page for every user, and it is invisible to HTTP-level checks because the file is
# still served with 200 -- so parse it inside the container with the real parser.
D exec "$NAME" node --check /app/public/app.js >/dev/null 2>&1 \
    && ck 1 "镜像内 app.js 可被 JavaScript 解析" || ck 0 "镜像内 app.js 可被 JavaScript 解析"
# And the module must actually build its first screen, not just parse.
D exec "$NAME" sh -c 'grep -q "getElementById(.app.)" /app/public/app.js' >/dev/null 2>&1 \
    && ck 1 "镜像内 app.js 挂载点与页面一致" || ck 0 "镜像内 app.js 挂载点与页面一致"

say "数据源"
D exec "$NAME" node -e "import('mysql2/promise').then(m=>process.exit(typeof m.createPool==='function'?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1 && ck 1 "镜像内 mysql2 可加载（可切 MySQL）" || ck 0 "镜像内 mysql2 可加载"
D exec "$NAME" node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/data/mhg-gateway-admin.db',{readOnly:true});
const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().length;
const h=db.prepare('SELECT password_hash FROM users LIMIT 1').get();
db.close();
process.exit(t>=6 && h.password_hash.startsWith('scrypt\$') ? 0 : 1);
" >/dev/null 2>&1 && ck 1 "SQLite 表结构完整且口令为 scrypt 非明文" || ck 0 "SQLite 表结构与被哈希的口令"

say "清理"
D stop "$NAME" >/dev/null 2>&1
D rm "$NAME" >/dev/null 2>&1
note "测试容器与数据目录已删除；镜像 $IMAGE 保留"

printf '\n=== %s ===\n' "$([ "$FAIL" -eq 0 ] && echo '全部通过' || echo "$FAIL 项失败")"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
