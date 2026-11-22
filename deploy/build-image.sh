#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Build the container image and smoke-test it.
#
# This is the script to run on a machine that has Docker. It is not run in CI here
# because the development machine has no Docker daemon; `deploy/verify-container.js`
# is what checks the container inputs without one.
#
#   ./deploy/build-image.sh              # build + smoke test
#   ./deploy/build-image.sh --no-test    # build only
#   TAG=mhg-admin:1.0.0 ./deploy/build-image.sh
#
# Exit codes: 0 ok, 1 build failed, 2 smoke test failed, 3 prerequisites missing.

set -eu

IMAGE="${TAG:-mhg-gateway-admin:latest}"
PORT="${SMOKE_PORT:-18720}"
RUN_TEST=1

for arg in "$@"; do
    case "$arg" in
    --no-test) RUN_TEST=0 ;;
    -h|--help)
        sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    *) echo "未知参数: $arg" >&2; exit 3 ;;
    esac
done

say() { printf '\n== %s\n' "$1"; }

say "检查前提"
if ! command -v docker >/dev/null 2>&1; then
    echo "找不到 docker 命令。镜像构建需要 Docker（或其他兼容的容器引擎）。" >&2
    echo "没有 Docker 时仍可直接用 Node 运行: node src/index.js" >&2
    exit 3
fi
docker version >/dev/null 2>&1 || { echo "docker 已安装但守护进程不可用（Docker Desktop 是否已启动？）" >&2; exit 3; }
echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"

# The static checks run first: they catch a broken COPY/.dockerignore in seconds
# instead of after a full layer build.
say "容器输入静态检查"
if command -v node >/dev/null 2>&1; then
    node deploy/verify-container.js
else
    echo "跳过（本机没有 node）"
fi

say "构建镜像 $IMAGE"
docker build -t "$IMAGE" .

if [ "$RUN_TEST" = "0" ]; then
    say "已跳过冒烟测试"
    exit 0
fi

say "冒烟测试"
TMPDATA="$(mktemp -d)"
CONTAINER="mhga-smoke-$$"
cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$TMPDATA" || true
}
trap cleanup EXIT INT TERM

docker run -d --name "$CONTAINER" \
    -e MHGA_PORT="$PORT" \
    -p "127.0.0.1:$PORT:$PORT" \
    -v "$TMPDATA:/data" \
    "$IMAGE" >/dev/null

fail=0
wait_url() {
    url="$1"; want="$2"; tries=60
    while [ "$tries" -gt 0 ]; do
        body="$(curl -fsS "$url" 2>/dev/null || true)"
        if [ -n "$body" ] && printf '%s' "$body" | grep -q "$want"; then
            return 0
        fi
        # Surface a crash immediately instead of waiting out the whole timeout.
        if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
            echo "容器已退出，日志:" >&2
            docker logs "$CONTAINER" >&2 || true
            return 1
        fi
        tries=$((tries - 1))
        sleep 1
    done
    echo "等待 $url 超时" >&2
    docker logs "$CONTAINER" >&2 || true
    return 1
}

if ! wait_url "http://127.0.0.1:$PORT/api/health" '"ok":true'; then
    echo "FAIL /api/health 未就绪"; fail=1
else
    echo "PASS 健康检查"
fi

if ! wait_url "http://127.0.0.1:$PORT/api/session" '"setupComplete":false'; then
    echo "FAIL 全新数据卷应显示需要初始化"
    fail=1
else
    echo "PASS 首次打开显示需要初始化"
fi

if curl -fsS "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '网关管理'; then
    echo "PASS 首页可访问"
else
    echo "FAIL 首页不可访问"; fail=1
fi

# The console must have created its database and session secret on the volume.
if [ -f "$TMPDATA/mhg-gateway-admin.db" ] && [ -f "$TMPDATA/session-secret" ]; then
    echo "PASS 数据卷上生成了数据库与会话密钥"
else
    echo "FAIL 数据卷上缺少数据库或会话密钥"; ls -la "$TMPDATA" >&2 || true; fail=1
fi

# The process must not be root.
uid="$(docker exec "$CONTAINER" id -u 2>/dev/null || echo unknown)"
if [ "$uid" = "1000" ]; then
    echo "PASS 以非 root 用户运行 (uid=1000)"
else
    echo "注意: 运行用户 uid=$uid（预期 1000/node）"
fi

say "清理"
docker stop "$CONTAINER" >/dev/null 2>&1 || true

if [ "$fail" -ne 0 ]; then
    echo "冒烟测试失败" >&2
    exit 2
fi

cat <<EOF

镜像可用: $IMAGE

运行:
  docker run -d --name mhg-gateway-admin --restart unless-stopped \\
    -p 8720:8720 -p 25000-25009:25000-25009/udp -p 24000-24009:24000-24009/udp \\
    -v mhg-admin-data:/data $IMAGE

打开 http://<服务器IP>:8720/ 创建管理员账户。
EOF
