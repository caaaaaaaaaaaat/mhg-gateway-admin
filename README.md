# mhg-gateway-admin

**MHXX / MHGU 跨平台联机网关的服务器端批量管理控制台。**

把多台 `citra-gateway` 房间网关放在一台服务器上统一管理：网页登录、一条命令批量启动/停止、端口自动分配、每房日志、失败原因可见、账户分级。数据默认落在服务器本地的 SQLite，也可以换成 MySQL。附带 Docker 镜像。

> 房间的**协议翻译**由 [citra-gateway](../crossplay/citra-gateway/README.md) 完成。本项目只负责进程生命周期、配置存放和网页管理，不修改也不重写协议层。

## 验证到哪一步了

诚实说明交付状态，避免把「自动测试通过」当成「你可以直接无视地部署」：

| 项目 | 状态 |
|---|---|
| 单元测试（配置/密码/令牌/数据源契约） | ✅ 65 项，64 通过，1 跳过（MySQL 需真实库），0 失败 |
| HTTP API 与进程监管测试 | ✅ 含真实子进程启停、崩溃重启、熔断、日志轮转 |
| 端到端故事测试（首次使用/批量启停/只读/重启持久化） | ✅ 5 个故事全通过 |
| 真实进程 + 真实 HTTP 验证（`deploy/verify.js`） | ✅ 35/35 |
| 容器输入静态与启动验证（`deploy/verify-container.js`） | ✅ 47/47 |
| **实际 `docker build` 出镜像** | ✅ 已在 Ubuntu 24.04 + Docker 上构建通过，镜像 355 MB |
| 容器实际运行（真实 Docker 容器） | ✅ 35 项验收全过 + 容器删除重建后数据与账户仍在 |
| 真实浏览器渲染（容器页面） | ✅ 真实镜像 + 真实 Chrome 走完初始化→登录→6 个页面→退出，控制台零报错 |
| 真实网关二进制联机 | ❌ 未执行——上游网关是 Windows 构建；Linux 容器需自备 Linux 版 |

镜像已在真实服务器上构建并运行验证过（Ubuntu 24.04 / Docker，构建约 30 秒，`npm ci` 装入 12 个包含 mysql2）。验证内容包括：健康检查 1 秒就绪、`docker healthcheck` 达到 healthy、进程以 uid=1000（node）运行、数据与会话密钥落在 `/data` 卷且密钥权限 0600、首次打开要求初始化、登录后 CSRF 生效、无 CSRF 头的写操作返回 403、房间端口自动分配为 25000/25001、没有网关二进制时启动如实返回 409、**删除容器后用同一卷重建：不需要重新初始化、原账户可登录、房间与审计事件完整保留**、数据库为 SQLite 且口令为 scrypt 非明文、`mysql2` 可在镜像内加载、切到 MySQL 但连不上时退出码为 3 并给出可操作错误。

容器页面还在**真实浏览器**里验证过（真实镜像 → 真实容器 → Chrome）：首次打开渲染初始化表单、提交后要求重新登录、登录后进入控制台、6 个页面逐个打开并渲染、退出回到登录页，全程控制台零报错（包括 CSP）。

唯一无法在这里完成的是**真实网关二进制联机**：需要 Linux 版 `citra-gateway`。

---

## 目录

- [验证到哪一步了](#验证到哪一步了)
- [它解决什么问题](#它解决什么问题)
- [快速开始](#快速开始)
  - [方式一：直接用 Node 运行](#方式一直接用-node-运行)
  - [方式二：Docker](#方式二docker)
  - [方式三：Docker Compose（含可选 MySQL）](#方式三docker-compose含可选-mysql)
- [首次打开：创建管理员](#首次打开创建管理员)
- [网关程序放在哪里](#网关程序放在哪里)
- [配置文件完整说明](#配置文件完整说明)
- [数据源配置](#数据源配置)
  - [SQLite（默认）](#sqlite默认)
  - [MySQL](#mysql)
  - [新增其他数据源](#新增其他数据源)
- [环境变量](#环境变量)
- [端口与网络](#端口与网络)
- [反向代理与 HTTPS](#反向代理与-https)
- [命令行](#命令行)
- [HTTP 接口](#http-接口)
- [安全模型](#安全模型)
- [数据与备份](#数据与备份)
- [故障排查](#故障排查)
- [开发与测试](#开发与测试)
- [许可证](#许可证)

---

## 它解决什么问题

单机玩家的用法是 `XXGU-Gateway.exe` 图形界面：填服务器、点启动。但一台服务器要带多个房间（多个公会、多场同时进行）时，图形界面就不合适了：

| 需求 | 本项目 |
|---|---|
| 一次开十几个房间 | 一条“批量启动”，端口自动分配，冲突会明确报错 |
| 多个管理员分别看房间 | 网页登录，账户分「管理员 / 只读」 |
| 房间挂了要知道为什么 | 每个房间有状态、失败原因、可读日志，崩溃自动重启并留审计记录 |
| 重启服务器后不想丢配置 | SQLite 存本地，容器里挂一个 `/data` 卷即可 |
| 多个站点共用一套管理 | 数据源可换 MySQL |

---

## 快速开始

### 方式一：直接用 Node 运行

要求 **Node.js ≥ 22.5**（`node:sqlite` 是 Node 内置模块，不需要编译任何原生依赖）。

```bash
git clone <this-repo> mhg-gateway-admin
cd mhg-gateway-admin

# 1. 生成默认配置（也可以跳过，直接使用内置默认值）
node src/index.js --init-config

# 2. 部署前自检：配置能不能读、数据源能不能开、网关程序找没找到
node src/index.js --check

# 3. 启动
node src/index.js
```

看到这样的输出就成功了：

```
  MHXX/MHGU 网关管理控制台已启动
  访问地址: http://127.0.0.1:8720
  数据源:   sqlite
  首次使用: 打开页面后按提示创建管理员账户
```

打开 `http://<服务器IP>:8720/`。

> 如果 `--check` 提示「未找到 citra-gateway」，先照 [网关程序放在哪里](#网关程序放在哪里) 放好，否则房间建得出来但启动会失败（失败原因会显示在网页上）。

### 方式二：Docker

镜像里已经配置好 **SQLite 存容器内 `/data`**，只需挂一个卷。

**推荐用脚本构建**：它会先跑容器输入静态检查，构建完再自动起一个容器做冒烟测试（健康检查、首次打开显示需要初始化、数据卷生成数据库与会话密钥、非 root 运行）：

```bash
# Linux / macOS
chmod +x deploy/build-image.sh
./deploy/build-image.sh

# Windows（Docker Desktop）
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\build-image.ps1
```

脚本通过后会打印可直接粘贴的运行命令。也可以手动构建：

```bash
docker build -t mhg-gateway-admin .

docker run -d \
  --name mhg-gateway-admin \
  --restart unless-stopped \
  -p 8720:8720 \
  # 玩家要连的 Citra 网关端口（按实际房间数量加宽）
  -p 25000-25009:25000-25009/udp \
  -p 24000-24009:24000-24009/udp \
  -v mhg-admin-data:/data \
  # 可选：把 citra-gateway 二进制挂进来
  # -v /path/to/citra-gateway:/app/bin/citra-gateway:ro \
  mhg-gateway-admin
```

`/data` 里保存数据库、会话密钥和每房日志。**不挂卷 = 容器一删数据就没了。**

实测数据（Ubuntu 24.04 + Docker，4 核 3.6G 的云服务器）：

```
构建耗时  ~30 秒（基础镜像已缓存时约 25 秒）
镜像大小  355 MB
npm ci    12 个包（含可选的 mysql2）
启动就绪  1 秒
实测内存  空载约 40 MB
```

验证过程用的是独立容器名、独立端口（18720）和独立数据目录，没有触碰同机上已有的其他容器。

想在不构建镜像的前提下先验证容器相关输入（COPY 路径、`.dockerignore`、CRLF、entrypoint、健康检查、容器配置能否启动）：

```bash
node deploy/verify-container.js
```

### 方式三：Docker Compose（含可选 MySQL）

```bash
# SQLite（默认）
docker compose up -d --build

# 用 MySQL 作为数据源
docker compose --profile mysql up -d --build
# 然后设置控制台的环境变量：
#   MHGA_DB_DRIVER=mysql
#   MHGA_MYSQL_HOST=mysql
#   MHGA_MYSQL_USER=mhg
#   MHGA_MYSQL_PASSWORD=change-this-password
#   MHGA_MYSQL_DATABASE=mhg_gateway_admin
```

`docker-compose.yml` 里把 UDP 端口只发布了 10 个（25000-25009 / 24000-24009）作为示例。**你有多少个房间就要发布多少个端口**，并且与配置里的端口池保持一致。

---

## 首次打开：创建管理员

第一次打开页面时，控制台里**还没有任何账户**，页面会要求你创建唯一的管理员：

- 用户名 3–32 位，字母/数字/下划线/点/短横线，以字母或数字开头
- 密码至少 10 位（长度下限可在 `auth.passwordMinLength` 调整）
- 密码以 **scrypt** 哈希存储，数据库里没有明文

创建后请用这个账户登录。第一个账户是 **拥有者 (owner)**：不能被删除，也不能被降级。

> 这个初始化接口在管理员建立后会自动返回 409，所以不需要担心被人重新初始化。

之后可以在「账户」页创建更多账户：

| 角色 | 能做什么 |
|---|---|
| 拥有者 owner | 全部，且不可被删除 |
| 管理员 admin | 管理服务器/房间/账户，启停房间，看部署信息 |
| 只读 viewer | 看总览、房间、服务器、事件与日志，不能改任何东西 |

---

## 网关程序放在哪里

控制台本身不包含协议翻译，它调用 `citra-gateway` 可执行文件。按下面顺序查找：

1. 配置项 `gateways.binaryPath`（填绝对路径）
2. 配置项 `gateways.binSearchPaths` 里的目录，找 `citra-gateway`（Windows 上找 `citra-gateway.exe`）
   - 默认包含 `bin`（相对配置文件目录）、`/usr/local/bin`、`/usr/bin`
   - Docker 镜像里默认包含 `/app/bin`

推荐做法：

```bash
mkdir -p bin
cp /path/to/citra-gateway bin/
chmod +x bin/citra-gateway
node src/index.js --check    # 应该显示「网关程序: .../bin/citra-gateway」
```

**在 Linux 容器里运行需要 Linux 版本的二进制。** 上游项目当前的构建脚本面向 Windows（MinGW），要在容器里管理真实房间，需要一个 Linux/musl 静态链接的 `citra-gateway`。没有它控制台的其它功能（账户、配置、审计、端口规划）照常工作，只是点「启动」会明确提示找不到程序。

---

## 配置文件完整说明

配置是**一个 JSON 文件**，默认路径 `./config.json`（可用 `--config` 或 `MHGA_CONFIG` 指定）。**文件不存在不是错误**——内置默认值 + 环境变量就是一套可用配置。

字段完整列表：

```jsonc
{
  "server": {
    "host": "0.0.0.0",        // 监听地址。0.0.0.0 = 所有网卡
    "port": 8720,             // 控制台 HTTP 端口
    "publicUrl": "",          // 对外地址，用于生成链接；空 = 按请求推断
    "trustProxy": false       // 在反向代理后面时设为 true（读 X-Forwarded-Proto）
  },
  "auth": {
    "cookieName": "mhg_admin_session",
    "sessionTtlHours": 12,    // 会话空闲多久失效
    "sessionMaxDays": 30,     // 会话绝对上限（滑动续期也不会超过）
    "passwordMinLength": 10,  // 密码长度下限（8..256）
    "maxFailedLogins": 8,     // 连续失败几次锁定账户
    "lockoutMinutes": 15,     // 锁定分钟数
    "secretFile": "data/session-secret",  // 会话密钥存放路径，首次启动自动生成
    "secureCookies": "auto"   // "auto" | true | false；auto = 看起来是 HTTPS 就加 Secure
  },
  "storage": {
    "driver": "sqlite",       // "sqlite" | "mysql"
    "sqlite": { "path": "data/mhg-gateway-admin.db" },
    "mysql": {
      "host": "127.0.0.1", "port": 3306,
      "user": "mhg", "password": "", "database": "mhg_gateway_admin",
      "connectionLimit": 10, "ssl": false,
      "tablePrefix": ""       // 多套部署共用一个库时加前缀区分
    }
  },
  "gateways": {
    "binaryPath": "",                          // 空 = 去下面的目录里找
    "binSearchPaths": ["bin", "/usr/local/bin", "/usr/bin"],
    "citraPortRange": [25000, 25999],          // Citra 侧端口池（玩家连这个）
    "roomPortRange": [24000, 24999],           // 房间服务端端口池
    "runtimeDir": "data/rooms",                // 每房日志所在目录
    "extraArgs": [],                            // 追加给每个网关的参数（高级）
    "sampleIntervalMs": 2000,                   // 状态采样间隔
    "logRetentionDays": 7                       // 日志保留天数
  },
  "logging": {
    "level": "info",           // debug | info | warn | error
    "file": ""                 // 空 = 输出到 stdout（推荐给 systemd/docker）
  }
}
```

**相对路径**（如 `data/...`）按**配置文件所在目录**解析；`binaryPath`、`binSearchPaths`、`runtimeDir`、`sqlite.path`、`secretFile`、`logging.file` 都是这样。

配置项写错时程序会直接拒绝启动，并指到具体字段，例如：

```
配置错误: server.port: must be within 1..65535, got 0
配置错误: gateways.citraPortRange: low bound must be below high bound
```

### 端口池怎么规划

- 每个房间占 **一个 Citra 端口**（玩家连）和一个 **房间服务端端口**（网关向房间服务器声明）。
- 新建房间时留空端口 = 从池里按顺序挑第一个空闲的；填了具体端口 = 用你填的，若被占用会明确报 `port_in_use`。
- 池子用尽会报 `port_pool_exhausted`，提示你调整 `citraPortRange` / `roomPortRange`。
- **端口池大小要和 Docker 发布的 UDP 端口范围、防火墙规则一致。**

### 三种配置档 (profile)

| 配置档 | 传给网关的参数 | 适用 |
|---|---|---|
| `default` / `dual-host` | 控制面 + 双房主 + MHXX 探测档案（完整翻译） | 正常联机 |
| `legacy` | 只有监听/房间/密码，不开控制面 | 只做数据面转发；当翻译层出问题时的退路，攻击面更小 |

具体参数由 `src/lib/supervisor.js` 的 `buildGatewayArgs()` 统一拼装，与桌面版 `gateway-gui` 用的那套一致。

---

## 数据源配置

### SQLite（默认）

```json
"storage": { "driver": "sqlite", "sqlite": { "path": "data/mhg-gateway-admin.db" } }
```

- 用 Node 内置的 `node:sqlite`，**不需要编译原生模块**，也不需要装 sqlite3。
- 首次启动自动建表；已存在的库自动沿用。
- 已开启 WAL 模式，读写并发友好。
- 库文件 schema 版本不匹配时会明确拒绝启动，不会「带着未知结构继续跑」。

Docker 里默认路径是 `/data/mhg-gateway-admin.db`，落在挂载卷上。

### MySQL

```json
"storage": {
  "driver": "mysql",
  "mysql": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "mhg",
    "password": "你的密码",
    "database": "mhg_gateway_admin",
    "connectionLimit": 10,
    "ssl": false,
    "tablePrefix": ""
  }
}
```

步骤：

1. **先装可选依赖**（SQLite 部署不需要，所以它是 `optionalDependencies`）：

   ```bash
   npm install mysql2
   ```

   没装就切到 mysql 时，报错会直接告诉你这条命令：

   ```
   数据源初始化失败: mysql2 未安装。使用 MySQL 数据源前请执行: npm install mysql2 (MODULE_NOT_FOUND)
   ```

2. **准备库和账号**（表由程序自己建）：

   ```sql
   CREATE DATABASE mhg_gateway_admin CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'mhg'@'%' IDENTIFIED BY '你的密码';
   GRANT ALL PRIVILEGES ON mhg_gateway_admin.* TO 'mhg'@'%';
   FLUSH PRIVILEGES;
   ```

3. 改 `storage.driver` 为 `mysql`，填上连接信息，然后：

   ```bash
   node src/index.js --check
   ```

   自检会真正连一次库并建表。

要点：

- 表名前缀 `tablePrefix` 只允许字母、数字、下划线。想让多套部署共用一个库时用它区分（例如 `siteA_`）。
- 字符集固定 utf8mb4，房间名可以用中文。
- `ssl: true` 会启用 TLS（云数据库通常需要）。
- Docker Compose 里 `mysql` 服务的容器名就是 `mysql`，而镜像默认配置里 `mysql.host` 已经是 `mysql`，所以切驱动后不用改 host。

### 新增其他数据源

数据源是一个明确的接口，见 [`src/datasource/index.js`](src/datasource/index.js)。实现类继承 `Datasource` 并把所有方法写全即可，然后在 [`src/datasource/factory.js`](src/datasource/factory.js) 里加一个分支：

```js
// src/datasource/postgres.js
import { Datasource } from './index.js';

export class PostgresDatasource extends Datasource {
  get driver() { return 'postgres'; }
  async init() { /* 建连接 + 建表 */ return this; }
  async close() { /* 释放 */ }
  async ping() { /* 探活 */ }
  // 其余方法见 Datasource 的文档注释
}

// src/datasource/factory.js
if (driver === 'postgres') return new PostgresDatasource(config.storage.postgres);
```

接口约定（每个方法都标了字段含义）：时间戳一律是**毫秒整数**，布尔存 0/1，方法一律 `async`（这样网络后端可以无缝替换）。

`test/unit.datasource.test.js` 里的 `runContract(ds, ...)` 是一整套数据源行为契约，新驱动**跑通它就算合格**（MySQL 驱动也是这样验证的）。

---

## 环境变量

所有变量都可覆盖配置文件里的同名字段；空字符串视为「不覆盖」。

| 变量 | 对应配置 | 说明 |
|---|---|---|
| `MHGA_CONFIG` | — | 配置文件路径 |
| `MHGA_HOST` | `server.host` | 监听地址 |
| `MHGA_PORT` | `server.port` | 监听端口 |
| `MHGA_PUBLIC_URL` | `server.publicUrl` | 对外地址 |
| `MHGA_TRUST_PROXY` | `server.trustProxy` | `1`/`true` 开启 |
| `MHGA_DB_DRIVER` | `storage.driver` | `sqlite` / `mysql` |
| `MHGA_SQLITE_PATH` | `storage.sqlite.path` | |
| `MHGA_MYSQL_HOST` | `storage.mysql.host` | |
| `MHGA_MYSQL_PORT` | `storage.mysql.port` | |
| `MHGA_MYSQL_USER` | `storage.mysql.user` | |
| `MHGA_MYSQL_PASSWORD` | `storage.mysql.password` | |
| `MHGA_MYSQL_DATABASE` | `storage.mysql.database` | |
| `MHGA_MYSQL_TABLE_PREFIX` | `storage.mysql.tablePrefix` | |
| `MHGA_GATEWAY_BIN` | `gateways.binaryPath` | |
| `MHGA_RUNTIME_DIR` | `gateways.runtimeDir` | |
| `MHGA_LOG_LEVEL` | `logging.level` | |
| `MHGA_LOG_FILE` | `logging.file` | |

容器专用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MHGA_DATA_DIR` | `/data` | 入口脚本修正此目录的属主 |
| `MHGA_SKIP_CHOWN` | `0` | 设为 `1` 跳过属主修正（卷很大时省时间） |

---

## 端口与网络

```
                 玩家 Citra ──UDP:25000..25xxx──┐
                                               ├─► 控制台所在服务器
                 玩家 Citra ──UDP:25001..25yyy──┘   （每个房间一个端口）
                                                        │
                        Yuzu 玩家 ──► 房间服务器 ──UDP:24xxx──► 各房间网关
```

| 端口 | 协议 | 用途 | 谁需要能访问 |
|---|---|---|---|
| `8720`（可改） | TCP | 管理网页 | 管理员 |
| `citraPortRange`（默认 25000–25999） | UDP | 每个房间的 Citra 接入端口 | **玩家** |
| `roomPortRange`（默认 24000–24999） | UDP | 网关向房间服务器声明的端口 | 房间服务器 |

Docker 里这些 UDP 端口是**在容器内监听**的，所以必须用 `-p` 发布出来才能被玩家连到。发布多少个就对应多少个房间。

防火墙示例（ufw）：

```bash
sudo ufw allow 8720/tcp
sudo ufw allow 25000:25009/udp
sudo ufw allow 24000:24009/udp
```

---

## 反向代理与 HTTPS

控制台本身只监听 HTTP。放到 Nginx 后面时：

```nginx
server {
    listen 443 ssl http2;
    server_name gw.example.com;

    ssl_certificate     /etc/letsencrypt/live/gw.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gw.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8720;
        proxy_set_header Host $host;
        # 这两行让控制台知道「外部是 HTTPS」，从而给会话 cookie 加 Secure
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

然后设置 `MHGA_TRUST_PROXY=1`（或配置 `server.trustProxy: true`）与 `MHGA_PUBLIC_URL=https://gw.example.com`。

**`trustProxy` 只在确实位于可信代理后面时开启**：否则客户端可以伪造 `X-Forwarded-Proto`。这个头只用于决定 cookie 是否加 `Secure`，不参与鉴权，但仍应当正确配置。

---

## 命令行

```
mhg-gateway-admin [选项]

  --config <path>    配置文件路径（默认 ./config.json）
  --init-config      写出默认 config.json 后退出（已存在则不覆盖）
  --print-config     打印生效配置（密码显示为 ***）后退出
  --check            加载配置 + 打开数据源 + 自检后退出（部署前验证用）
  --host <addr>      覆盖监听地址
  --port <n>         覆盖监听端口
  --help / --version
```

退出码：`0` 成功，`2` 配置/参数错误，`3` 数据源或端口问题。

`--check` 的输出示例：

```
自检通过
  数据源: sqlite
  配置文件: /srv/mhg-gateway-admin/config.json
  监听: 0.0.0.0:8720
  管理员: 已初始化
  房间: 6
  网关程序: /srv/mhg-gateway-admin/bin/citra-gateway
  运行目录: /srv/mhg-gateway-admin/data/rooms
```

### systemd

见 [`deploy/mhg-gateway-admin.service`](deploy/mhg-gateway-admin.service)：

```bash
sudo useradd -r -s /usr/sbin/nologin -d /srv/mhg-gateway-admin mhg
sudo mkdir -p /srv/mhg-gateway-admin && sudo chown mhg:mhg /srv/mhg-gateway-admin
# 把源码解到 /srv/mhg-gateway-admin 后：
sudo cp deploy/mhg-gateway-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mhg-gateway-admin
sudo journalctl -u mhg-gateway-admin -f
```

---

## HTTP 接口

控制台自己的网页用的就是这套接口，脚本也可以直接用。成功返回 `{ "data": ... }`，失败返回 `{ "error": { "message", "code", "details?" } }`。

需要登录的接口靠 `Cookie` 会话；**所有写操作**还必须带 `x-csrf-token` 头（值取自 `/api/session` 或 `/api/login` 的返回）。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 探活，`/healthz` 同义 |
| GET | `/api/session` | 公开 | 是否已初始化、是否已登录、CSRF token、网关程序是否就绪 |
| POST | `/api/setup` | 公开 | 创建首个管理员（仅一次） |
| POST | `/api/login` | 公开 | 登录，返回 `csrfToken` |
| POST | `/api/logout` | 公开 | 退出并清 cookie |
| POST | `/api/password` | 已登录 | 改自己的密码，**吊销所有会话** |
| GET | `/api/dashboard` | viewer | 统计 + 房间 + 服务器 + 事件 + 网关程序状态 |
| GET/POST | `/api/servers` | viewer / admin | 列表 / 新增 |
| PATCH/DELETE | `/api/servers/:id` | admin | 改 / 删（被房间引用时拒删） |
| GET/POST | `/api/rooms` | viewer / admin | 列表 / 新增（端口留空自动分配） |
| PATCH/DELETE | `/api/rooms/:id` | admin | 改 / 删（运行中不能改需要重启的字段） |
| POST | `/api/rooms/:id/start` | admin | 启动；失败返回 409 + 原因 |
| POST | `/api/rooms/:id/stop` | admin | 停止（SIGTERM，5 秒后 SIGKILL） |
| POST | `/api/rooms/batch/:action` | admin | `start` / `stop` 批量，**逐房返回成功与否** |
| GET | `/api/rooms/:id/log` | viewer | 日志尾部（`?lines=200`） |
| GET/POST | `/api/users` | admin | 账户列表 / 新增 |
| DELETE | `/api/users/:id` | admin | 删除（拥有者与自身不可删） |
| GET | `/api/events` | viewer | 审计事件（`?roomId=&limit=`） |
| GET | `/api/diagnostics` | admin | 部署信息：数据源、网关程序路径、端口池占用 |

示例（curl）：

```bash
# 登录并取出 csrf
resp=$(curl -s -c jar.txt -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"..."}' \
     http://127.0.0.1:8720/api/login)
csrf=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["csrfToken"])')

# 批量启动房间 1 和 2
curl -s -b jar.txt -H "x-csrf-token: $csrf" -H 'Content-Type: application/json' \
     -d '{"ids":[1,2]}' http://127.0.0.1:8720/api/rooms/batch/start
```

---

## 安全模型

已经做到的：

- 密码 **scrypt** 哈希（N=2^17, r=8, p=1），哈希串自带参数，将来提高成本不会让旧密码失效
- 会话是**不透明随机串**，数据库只存 SHA-256，拖库也拿不到可用的会话
- 会话 cookie：`HttpOnly` + `SameSite=Lax` +（HTTPS 时）`Secure`
- 滑动过期 + **绝对上限** `sessionMaxDays`
- 所有写操作强制 **CSRF 头**校验（双提交，绑定到会话行）
- 失败登录计数 + 账户锁；未知用户也走一遍等价的哈希计算，避免靠响应时间枚举账户
- 改密码会**吊销该账户全部会话**
- 统一安全响应头：严格 **CSP**（禁内联脚本/样式、禁外部源）、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: no-referrer`
- 静态文件路径做了**穿越防护**（不能读 `public/` 以外的东西），扩展名白名单
- 房间/服务器密码**永不回显给浏览器**，**也永不写进日志**（启动命令行里的密码被替换成 `***`）
- 子进程用数组参数 + `shell: false` 启动，房间名不可能变成命令
- 容器内以非 root 的 `node` 用户运行

明确的边界：

- **没有实现多因素认证。**
- **没有防暴力破解的 IP 限速**（有按账户的失败锁定）。暴露在公网时建议在反向代理层加限速。
- 不防「已经拿到服务器系统权限」的攻击者。
- 首次初始化接口在管理员建立前是开放的——这是首次部署必需的设计，建立后自动关死。请在可信网络里完成首次初始化。

公网部署建议：**HTTPS + 强密码 + 只对管理员开放 8720**（玩家只需要 UDP 端口）。

---

## 数据与备份

需要备份的只有一块目录：

| 内容 | SQLite 部署 | Docker |
|---|---|---|
| 数据库 | `data/mhg-gateway-admin.db`（含 `-wal`/`-shm`） | `/data/mhg-gateway-admin.db` |
| 会话密钥 | `data/session-secret` | `/data/session-secret` |
| 每房日志 | `data/rooms/room-<id>.log*` | `/data/rooms/...` |

```bash
# 热备 SQLite（WAL 模式下安全）
sqlite3 data/mhg-gateway-admin.db ".backup 'backup-$(date +%F).db'"
```

```bash
# Docker
docker run --rm -v mhg-admin-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/mhg-admin-$(date +%F).tar.gz -C /data .
```

- `session-secret` 只是随部署生成的密钥文件，删掉后下次启动会重新生成（不影响账户和房间数据）。
- 日志按 `logRetentionDays` 自动清理，单文件超过 2 MiB 自动轮转，保留 3 份。

---

## 故障排查

**页面打不开**
1. `node src/index.js --check` 看自检是否通过
2. 确认端口：`ss -lntp | grep 8720`
3. Docker：`docker logs mhg-gateway-admin`，容器入口脚本会明确打印属主修正和网关程序缺失
4. 反向代理后面：`MHGA_TRUST_PROXY=1`、`MHGA_PUBLIC_URL` 是否设置

**登录后立刻退回登录页**
- cookie 没存下来：HTTPS 下 `secureCookies` 必须是 `auto`/`true`；HTTP 下如果强设为 `true`，浏览器会丢弃 cookie
- 时间不同步：会话有绝对过期时间，服务器时钟偏差过大会让会话立即失效

**点「启动」提示找不到 citra-gateway**
- 照 [网关程序放在哪里](#网关程序放在哪里) 放好，再跑 `--check` 确认
- Docker：确认挂载了 `/app/bin/citra-gateway` 且可执行

**房间显示「异常」并快速失败**
- 看该房间日志（房间列表 → 日志）。常见原因：房间服务器地址/端口不对、密码错、端口被别的程序占用
- 反复退出 5 次后会自动熔断并停止重试，避免刷屏；原因写在房间的失败信息里

**端口冲突**
- 新建房间时明确报 `port_in_use`：换端口或改端口池
- 报 `port_pool_exhausted`：端口池用完，扩大 `citraPortRange` / `roomPortRange`

**MySQL 切不过去**
- `npm install mysql2`
- `--check` 会真正连库，报错直接反映网络/账号/库权限问题
- 注意 `tablePrefix` 只能含字母数字下划线

---

## 开发与测试

```bash
npm test                    # 全量：配置 / 安全原语 / 数据源契约 / API / 进程监管 / 端到端故事
npm run test:unit           # 只跑单元
npm run test:api            # 只跑 HTTP 与进程
npm run check               # 语法检查

node deploy/verify.js           # 真实进程 + 真实 HTTP 端到端验证（35 项）
node deploy/verify-container.js # 容器输入验证，不需要 Docker（47 项）
./deploy/verify-image.sh        # 已有镜像的深度验收，需要 Docker（33 项）
```

四个验证脚本的分工：

| 脚本 | 是否起真实进程 | 是否需要 Docker | 验证什么 |
|---|---|---|---|
| `npm test` | 进程内 + 真实子进程（stub 网关） | 否 | 业务逻辑与 HTTP 契约 |
| `deploy/verify.js` | 是（独立 `node src/index.js` 进程） | 否 | 像用户一样操作一遍，含重启持久化 |
| `deploy/verify-container.js` | 是（用容器环境变量启动） | 否 | 镜像里会用到的一切，除 `docker build` 本身 |
| `deploy/verify-image.sh` | 是（真实容器） | 是 | 镜像构建后的深度验收：业务全流程 + 删容器重建的持久化 |

`deploy/verify-image.sh` 在共享服务器上是安全的：容器名带唯一前缀并在结束后删除、只用通过检查确认空闲的回环端口、从不执行全局 prune、从不停止或过滤非自己创建的容器。

容器相关已在真实环境验证过：Ubuntu 24.04 + Docker 上 `docker build` 通过（355 MB，约 30 秒），随后用独立容器名/端口/数据目录跑完 33 项验收（含删除容器后用同一卷重建），未触碰同机其他 15 个容器。

测试覆盖（全部使用真实代码路径，只有网关二进被替换成一个 Node 小脚本）：

- **config**：默认值完整性、文件/环境变量优先级、路径解析、BOM、错误定位、深合并
- **security**：scrypt 哈希与校验、盐随机、参数从哈希串读取、畸形哈希不抛异常、Unicode 归一化、密码策略、随机 token、`timingSafeEqual`、cookie 解析与序列化（含原型污染）
- **datasource**：SQLite（磁盘/内存/重开/未来版本拒绝）与 MySQL（可选依赖缺失的可操作报错；装了 mysql2 时跑同一套契约）
- **API**：初始化、登录/锁定、CSRF、登出、服务器与房间 CRUD、端口池分配与冲突、运行中改配置的拒绝、批量操作逐房结果、只读角色全路径拒绝、账户与拥有者保护、改密码吊销会话、请求体限制、静态资源与安全头、路径穿越、405/404 语义、密码不回显
- **supervisor**：参数拼装、端口分配、二进制查找、缺少程序时的拒绝、启动/停止真实进程、崩溃重启与退避、**崩溃熔断**、日志读取与轮转、日志保留、重启后不静默重启遗留房间、停用会取消待执行的重启
- **端到端故事**：首次使用全流程、真实进程批量启停、只读审计、**重启后数据仍在**、前端与后端接口一致性
- **容器输入**：每个 COPY 源存在且未被 `.dockerignore` 排除、entrypoint 为 LF 且所用命令由镜像提供、健康检查 JS 可解析、容器配置能真正启动并写出数据库

本轮开发中修掉的两个真实缺陷（都已加测试，避免回归）：

1. **崩溃熔断永远不会触发**：重启计数挂在每次尝试新建的进程条目上，重启一次计数就清零，于是一个配置错误、启动即退出的房间会无限重启。计数器改为按房间保存在 supervisor 上。
2. **停止房间不会取消待执行的重启**：退避期间的定时器在进程条目里，而条目在退出时已被删除，`stopRoom` 找不到它；操作员点了停止，房间仍会自己回来。定时器改为按房间单独存放。

`node:sqlite` 在 Node 22 上会打印一次 `ExperimentalWarning`，这不是错误。

### 项目结构

```
mhg-gateway-admin/
├── src/
│   ├── index.js              入口：参数、启动、信号处理
│   ├── app.js                HTTP 组装（路由、鉴权、静态、错误）
│   ├── lib/
│   │   ├── config.js         配置默认值 + 校验
│   │   ├── auth.js           初始化/登录/会话/CSRF/角色
│   │   ├── password.js       scrypt 哈希与密码策略
│   │   ├── tokens.js         随机 token、cookie
│   │   ├── supervisor.js     网关进程监管（核心）
│   │   ├── http.js           路由与请求/响应
│   │   ├── static.js         静态资源（含穿越防护）
│   │   ├── validate.js       字段校验
│   │   └── logger.js         结构化日志
│   ├── datasource/
│   │   ├── index.js          数据源接口与 schema 说明
│   │   ├── sqlite.js         node:sqlite 实现
│   │   ├── mysql.js          mysql2 实现
│   │   └── factory.js        工厂
│   └── routes/api.js         全部 API 路由
├── public/                   前端（原生 JS/CSS，无构建步骤）
├── test/                     自动化测试
├── config/                   容器用配置
├── deploy/
│   ├── mhg-gateway-admin.service   systemd 单元
│   ├── build-image.sh / .ps1       构建镜像 + 冒烟测试
│   ├── verify.js                   真实进程端到端验证
│   └── verify-container.js         容器输入验证（无需 Docker）
├── Dockerfile
├── docker-compose.yml
└── config.example.json
```

---

## 许可证

GPL-3.0-or-later。本项目不含游戏 ROM、密钥、存档，不绕过任何付费验证，请勿连接官方服务器。
