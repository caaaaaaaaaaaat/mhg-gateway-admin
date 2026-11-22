<#
.SYNOPSIS
    Build the container image and smoke-test it (Windows / PowerShell host).

.DESCRIPTION
    The Linux equivalent is deploy/build-image.sh. This script exists so a Windows
    machine with Docker Desktop can build the same image without a POSIX shell.

    It is NOT run in this repository's verification because the development machine
    has no Docker daemon. deploy/verify-container.js performs the checks that are
    possible without one.

.PARAMETER Tag
    Image tag. Default: mhg-gateway-admin:latest

.PARAMETER Port
    Host port used by the smoke test. Default: 18720

.PARAMETER NoTest
    Build only; skip the smoke test.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\build-image.ps1
#>
[CmdletBinding()]
param(
    [string]$Tag = 'mhg-gateway-admin:latest',
    [int]$Port = 18720,
    [switch]$NoTest
)

$ErrorActionPreference = 'Stop'
function Say($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Say '检查前提'
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Write-Error '找不到 docker 命令。镜像构建需要 Docker Desktop 或其他兼容容器引擎。没有 Docker 时仍可直接用 Node 运行: node src/index.js'
    exit 3
}
try {
    docker version --format '{{.Server.Version}}' | Out-Null
} catch {
    Write-Error 'docker 已安装但守护进程不可用（Docker Desktop 是否已启动？）'
    exit 3
}
Write-Host "docker 可用"

Say '容器输入静态检查'
if (Get-Command node -ErrorAction SilentlyContinue) {
    node deploy/verify-container.js
    if ($LASTEXITCODE -ne 0) {
        Write-Error '静态检查未通过，停止构建'
        exit 1
    }
} else {
    Write-Host '跳过（本机没有 node）'
}

Say "构建镜像 $Tag"
docker build -t $Tag .
if ($LASTEXITCODE -ne 0) { Write-Error 'docker build 失败'; exit 1 }

if ($NoTest) {
    Say '已跳过冒烟测试'
    exit 0
}

Say '冒烟测试'
$container = "mhga-smoke-$PID"
$tmpData = Join-Path ([System.IO.Path]::GetTempPath()) "mhga-smoke-$PID"
New-Item -ItemType Directory -Path $tmpData -Force | Out-Null

function Cleanup {
    docker rm -f $container 2>&1 | Out-Null
    Remove-Item -Recurse -Force $tmpData -ErrorAction SilentlyContinue
}

$failed = 0
try {
    # Docker Desktop on Windows accepts a Windows path for a bind mount.
    docker run -d --name $container `
        -e "MHGA_PORT=$Port" `
        -p "127.0.0.1:${Port}:${Port}" `
        -v "${tmpData}:/data" `
        $Tag | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'docker run 失败' }

    function Wait-Ok([string]$url, [string]$needle, [int]$seconds = 60) {
        for ($i = 0; $i -lt $seconds; $i++) {
            try {
                $body = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3).Content
                if ($body -match $needle) { return $true }
            } catch { }
            $running = docker ps --format '{{.Names}}'
            if ($running -notcontains $container) {
                Write-Host '容器已退出，日志:' -ForegroundColor Red
                docker logs $container
                return $false
            }
            Start-Sleep -Seconds 1
        }
        Write-Host "等待 $url 超时，日志:" -ForegroundColor Red
        docker logs $container
        return $false
    }

    if (Wait-Ok "http://127.0.0.1:$Port/api/health" '"ok":true') {
        Write-Host 'PASS 健康检查'
    } else { Write-Host 'FAIL 健康检查未就绪' -ForegroundColor Red; $failed = 1 }

    if (Wait-Ok "http://127.0.0.1:$Port/api/session" '"setupComplete":false') {
        Write-Host 'PASS 首次打开显示需要初始化'
    } else { Write-Host 'FAIL 全新数据卷应显示需要初始化' -ForegroundColor Red; $failed = 1 }

    try {
        $html = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5).Content
        if ($html -match '网关管理') { Write-Host 'PASS 首页可访问' }
        else { Write-Host 'FAIL 首页内容不符' -ForegroundColor Red; $failed = 1 }
    } catch {
        Write-Host 'FAIL 首页不可访问' -ForegroundColor Red; $failed = 1
    }

    if ((Test-Path (Join-Path $tmpData 'mhg-gateway-admin.db')) -and (Test-Path (Join-Path $tmpData 'session-secret'))) {
        Write-Host 'PASS 数据卷上生成了数据库与会话密钥'
    } else {
        Write-Host 'FAIL 数据卷上缺少数据库或会话密钥' -ForegroundColor Red
        $failed = 1
    }

    $uid = (docker exec $container id -u 2>$null)
    if ($uid -eq '1000') { Write-Host "PASS 以非 root 用户运行 (uid=$uid)" }
    else { Write-Host "注意: 运行用户 uid=$uid（预期 1000/node）" -ForegroundColor Yellow }
} catch {
    Write-Host "冒烟测试异常: $_" -ForegroundColor Red
    $failed = 1
} finally {
    Say '清理'
    Cleanup
}

if ($failed -ne 0) {
    Write-Error '冒烟测试失败'
    exit 2
}

Write-Host @"

镜像可用: $Tag

运行:
  docker run -d --name mhg-gateway-admin --restart unless-stopped ``
    -p 8720:8720 -p 25000-25009:25000-25009/udp -p 24000-24009:24000-24009/udp ``
    -v mhg-admin-data:/data $Tag

打开 http://<服务器IP>:8720/ 创建管理员账户。
"@ -ForegroundColor Green
