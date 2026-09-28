# 本地开发与远程部署

面向「采集程序跑在本机、数据库和 Redis 在远程机器」这套拓扑（`src/db/tunnel.js` 描述的
设计）。本机跑采集程序，远端一台 Linux 采集机承载 PG/Redis，两者都只发布在回环地址上。

## 1. 前置

| 依赖 | 说明 |
|---|---|
| Node | 与生产镜像同大版本（`node -v`） |
| Camoufox | Python 侧。项目内 venv 已装好，`.env` 的 `ONEGL_CAMOUFOX_PYTHON` 指向它 |
| uBlock 插件 | 生产镜像内置在 `/opt/onegl-addons/ublock`，**本地没有**，必须单独准备 |
| SSH | 到采集机的密码登录；OpenSSH 无法从环境变量读密码 |

### uBlock 为什么是硬前置

Camoufox 首次启动会自己去 AMO 下载 uBlock，而 `docs/MULTI_PLATFORM_LESSONS.md` §5 记着
生产环境不能依赖运行期访问外网。所以生产镜像把它打进 `/opt/onegl-addons/ublock` 并在
`browser.js` 里 fail closed（`ONEGL_CAMOUFOX_UBLOCK_PATH` 一旦显式配置，路径无效就报错，
不静默降级）。本地 checkout 缺这个目录，`readyz` 会一直报 camoufox not ready。

从生产镜像里取一份即可：

```bash
docker exec <api-or-worker> tar -cf - -C /opt/onegl-addons ublock > ublock.tar
# 解压到 .runtime-addons/ublock，然后：
ONEGL_CAMOUFOX_UBLOCK_PATH=<abs path>/.runtime-addons/ublock
```

`.runtime-addons/` 已在 `.gitignore` 里。

## 2. 隧道

```bash
npm run db:tunnel      # 保持窗口开着
```

它把本机 `127.0.0.1:15432` → 远端 `127.0.0.1:5432`（PG），`16380` → `6380`（Redis）。

**在无 TTY 的自动化场景下 `ssh` 读不到密码**，用 paramiko 建隧道时注意方向：
`Transport.request_port_forward` 是让**服务器**监听并把连接转发进本会话，方向是反的。
需要的是「本机 listen + 对每个连接开一个 `direct-tcpip` 通道」。

隧道起来后先验证它真的能通，而不是只看端口在听：

```bash
npm run db:status      # 能列出 applied 迁移就说明 PG 通了
```

## 3. 起服务

```bash
npm run db:status      # 确认迁移状态
npm run api:serve      # http://127.0.0.1:3200
npm run worker         # 采集 worker
npm run serve          # 只读操作台 http://127.0.0.1:3100
```

`api:serve` 会打印 readiness 与 master key 状态。**注意 `readyz` 报 503 不一定是故障**：
`migrations` 检查项在有 pending 迁移时也会拉低整体状态，先看具体是哪一项 not ready。

## 4. 验证一个平台

顺序不能颠倒——每一步都能独立证伪，比一次跑完整链路更快定位。

```bash
# 1) 注册闸门：平台在不在可执行集合里
curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:3200/v1/providers

# 2) 平台闸门：传错平台码必须被干净地拒绝（422 unsupported_platform，不是 500）
curl -s -X POST http://127.0.0.1:3200/v1/tasks   -H "authorization: Bearer $KEY" -H 'content-type: application/json'   -d '{"name":"t1","platforms":["nope"],"questions":[{"text":"x"}]}'

# 3) 真的跑一次（小批量，用生产路径而不是手工探针）
curl -s -X POST http://127.0.0.1:3200/v1/tasks   -H "authorization: Bearer $KEY" -H 'content-type: application/json'   -d '{"name":"t1","platforms":["zhipu"],"questions":[{"text":"x"}]}'
# 取 task_id 后：POST /v1/tasks/{id}/executions  body {"platforms":["zhipu"]}

# 4) worker 日志里看事件，而不是只看 status
docker logs -f <worker> | grep -E 'job-done|job-error|fingerprint-rotated|window-rotated'
```

**建任务时 `projectId` 与 `external_id` 要一起给且用同一个唯一值。** `service_tasks`
上有 `UNIQUE (project_id)` 与 `UNIQUE (tenant_id, external_id)`，只给 `external_id` 会
复用上一个任务的项目而撞 `project_id`；而 23505 一律被报成 "external_id is already used"，
报错会指向错误的原因（见 `MULTI_PLATFORM_LESSONS.md` §10.3）。

## 5. 部署到采集机

采集机上跑的是**同步过去的源码树，不是 git checkout**。

```bash
# 1) 先备份（任何推送之前）
tar czf /data/onegl-backup-$(date +%Y%m%d-%H%M%S).tgz -C /data/onegl   --exclude=node_modules --exclude=.git --exclude=.onegl --exclude=.venv src migrations docs

# 2) 只推确定属于本次改动的文件
# 3) 重新构建受影响的镜像（各服务是独立镜像，不能互相打标签）
docker build -f Dockerfile -t onegl-api:latest .
docker build -f Dockerfile -t onegl-worker:latest .

# 4) 用**线上那个** compose project 重建
cd /data/scrm/docker && docker compose -p <project> \
  -f /data/scrm/docker/docker-compose-ordered.yml \
  -f /data/onegl/deploy/docker-compose.scrm.yml \
  up -d --force-recreate onegl-api onegl-worker

# 5) 验证模块图能加载，而不只是 build 成功
docker exec <api> sh -c 'cd /app && node -e "import("/app/src/providers/index.js").then(()=>console.log("ok"))"'
```

`project` 名与服务键都带前缀：容器名 `onegl-app-onegl-api-1` 对应 project `onegl-app`
与服务键 `onegl-api`。用错 project 会在另一个 network 里找不到数据库，表现为
`EAI_AGAIN` 而不是任何配置错误；用错服务键则是 `no such service`——两种都不会改到任何东西，
所以看起来像"部署成功"。

**推文件之前先确认目标文件当前的引用关系在主机上成立。** 本地 checkout 可能是另一条
开发线，它的文件 import 了从未部署到该主机的模块；旧镜像里跑的是另一版文件，这个坏
import 处于潜伏状态，逐文件覆盖会把它唤醒（`MULTI_PLATFORM_LESSONS.md` §12 有完整复盘）。

## 6. 配置改动落在哪

| 键 | 位置 | 影响面 |
|---|---|---|
| `ONEGL_WINDOW_RESET_*` | `deploy/.env.production`（compose `env_file`） | 该主机上所有平台 |
| `ONEGL_MIN_DELAY_MS` / `MAX` / `ACCOUNT_HOURLY_LIMIT` | 同上 | **全局**，`profile.limits` 不被消费 |
| `ONEGL_API_KEY` | 同上 | 探针脚本从容器 env 读，不要写进脚本 |

改完 `env_file` 之后必须 `--force-recreate` 容器才生效，`restart` 不够。

## 7. 排查时不要做的事

- **不要靠反复查业务库推断平台侧事实。** 匿名能不能访问、页面结构、限额这些都是平台行为，
  跑一次探针记下来即可。
- **不要在本地"上次跑过"的路径上假设它被走过。** 智谱的引导弹层在本地 profile 里早已被
  记住而不再出现，所以本地的关闭逻辑从未真正执行；到容器冷启动第一次跑就失败。
- **不要把"配置改对了"当成"生效了"。** 判据是日志里出现对应事件：`fingerprint-rotated`
  才是换指纹，`window-rotated` 只是换会话。
