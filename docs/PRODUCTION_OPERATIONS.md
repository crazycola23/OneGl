# OneGl 生产运维：SLO、告警与部署

这一层只解决一件事：OneGl 上线后，故障要能被发现、被定位、被恢复，而不是等客户来反馈。

## 进程划分

生产环境建议把下面 5 个进程分开运行：

- `npm run api:serve`：OpenAPI 服务、远程账号绑定、`/readyz`、`/metrics`。
- `npm run worker`：豆包真实采集。默认仍保持单账号串行和保守节奏。
- `npm run monitor:worker`：把每日/每周监测计划物化为普通执行任务。
- `npm run webhook:worker`：向 SaaS 主平台投递业务事件。
- `npm run alert:worker`：评估系统 SLO，并向运维告警地址发送 firing/resolved 事件。

API 与 Worker 必须能读取同一份 `ONEGL_DATA_DIR`，因为远程登录写入的加密 storageState 需要由 Worker 使用。Docker Compose 示例使用共享 volume；Kubernetes 示例要求 RWX PVC。

## SLO 检查

一次性检查：

```bash
npm run slo:check
```

退出码：

- `0`：当前没有告警。
- `1`：至少一个 warning。
- `2`：至少一个 critical。

默认滚动窗口 15 分钟。默认规则：

| 信号 | 默认条件 | 级别 |
| --- | --- | --- |
| Redis | 不可用 | critical |
| Doubao Worker | 心跳 offline/unknown | critical |
| Worker | 心跳 degraded | warning |
| API 5xx | 至少 20 个请求且 5xx > 2% | critical |
| API p95 | 至少 20 个请求且 p95 > 3000ms | warning |
| Execution | 至少 5 个 terminal execution，partial+failed > 20% | critical |
| 豆包账号 | 需要人工处理的账号 > 0 | warning |
| Webhook | 窗口内有耗尽重试的事件 | warning |

这些阈值是 OneGl 的运维护栏，不是豆包官方限制。上线后应根据自己的正常基线调整。

## Alert Worker

启动：

```bash
npm run alert:worker
```

生产模式需要：

```env
ONEGL_ALERT_WEBHOOK_URL=https://ops.example.com/onegl-alerts
ONEGL_ALERT_SIGNING_KEY=<至少 32 个随机字符>
```

告警目标必须是无 URL credential 的公网 HTTPS 地址，网络层继续使用 OneGl 的 SSRF 防护：拒绝 loopback/private/link-local/reserved IP，不跟随重定向，并将实际连接固定到预验证的公网地址。

告警状态保存在 PostgreSQL `service_ops_alert_states`。同一个问题第一次出现发送 `firing`，恢复发送 `resolved`；持续故障默认每 60 分钟提醒一次。通知失败不会被标记为成功，下次轮询继续重试。

告警 payload 只包含聚合运维数据，不包含 Prompt、豆包回答、Cookie、storageState、API Key、Authorization 或请求/响应 body。

示例：

```json
{
  "id": "ops_0123456789abcdef0123456789abcdef",
  "type": "ops.alert.firing",
  "occurred_at": "2026-09-16T12:00:00.000Z",
  "alert": {
    "key": "api_5xx_rate_high",
    "severity": "critical",
    "state": "firing",
    "summary": "API 5xx rate is above the configured SLO threshold.",
    "details": {
      "requests": 120,
      "server_errors": 5,
      "observed_rate": 0.0417,
      "threshold": 0.02,
      "window_minutes": 15
    },
    "first_fired_at": "2026-09-16T11:58:00.000Z",
    "resolved_at": null
  }
}
```

签名头：

- `X-OneGl-Alert-Event`
- `X-OneGl-Alert-Event-Id`
- `X-OneGl-Timestamp`
- `X-OneGl-Signature: v1=<hex hmac sha256>`

签名内容与业务 webhook 一样使用 `timestamp + "." + rawBody`，但密钥必须使用独立的 `ONEGL_ALERT_SIGNING_KEY`。

## Docker Compose

镜像：

```bash
docker build -t onegl:local .
```

准备配置：

```bash
cp deploy/.env.production.example deploy/.env.production
# 修改所有 replace-me / example 地址和密钥
```

先确认 PostgreSQL、Redis 是可达的生产服务，然后：

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

Compose 的 API 只绑定 `127.0.0.1`，应通过 TLS reverse proxy 或私网入口提供给 SaaS 主平台，不建议直接把 3200 暴露到公网。

### Camoufox / 无桌面服务器

生产镜像默认使用：

```env
ONEGL_BROWSER=camoufox
ONEGL_CAMOUFOX_PYTHON=/opt/camoufox/bin/python
ONEGL_CAMOUFOX_MODE=virtual
```

`virtual` 模式不要求 Ubuntu Desktop、GNOME/KDE 或物理显示器。OneGl 为每个 Camoufox 浏览器会话启动独立 Xvfb display，浏览器仍以有窗口模式运行；会话关闭时 Xvfb 一起回收。API 的 Remote Auth 与 Worker 都走同一套 `launchBrowserSession()`，因此登录和后续采集保持同一浏览器后端。

另外两个模式：

- `headless`：使用 Camoufox 原生 headless，适合诊断或没有 Xvfb 的环境。
- `headful`：使用真实 DISPLAY，主要用于本地开发和人工调试。

Docker 镜像仍安装 Chromium，便于临时设置 `ONEGL_BROWSER=chromium` 排查浏览器兼容问题；生产默认不再是 Chromium。

## Kubernetes

模板位于 `deploy/kubernetes/`。

1. 构建并推送镜像，替换 `ghcr.io/example/onegl:latest`。
2. 使用 Secret Manager / External Secrets 创建 `onegl-secrets`。`secret.example.yaml` 只能作为字段示例，不能带占位值直接上线。
3. 为 `onegl-data` 提供支持 `ReadWriteMany` 的存储，因为 API 远程登录与 Worker 需要共享加密 storageState。
4. 先运行并等待 `onegl-migrate` Job 成功。
5. 再启动 API、Worker、Monitor、Webhook、Alert deployments。

模板默认只有 1 个 Doubao Worker。即使数据库已有跨 Worker 锁，也不要为了吞吐量随意放大豆包浏览器并发；扩容应以真实账号容量、现有限额和风险控制为准。

## Prometheus

`/metrics` 仍需要独立 `ONEGL_METRICS_TOKEN`。`deploy/prometheus/onegl-rules.yaml` 提供基础设施兜底规则：数据库指标不可用、Worker offline、账号需要人工处理、Webhook 永久失败、API 5xx 比率。

数据库窗口 p95 与 Execution partial/failed 比率由 OneGl Alert Worker 统一计算，避免 Prometheus 与 OneGl 使用不同的时间窗口或样本定义。

## 上线前最少检查

```bash
npm run db:migrate
npm run runtime:check -- --role api
npm run runtime:check -- --role worker
npm run runtime:check -- --role monitor
npm run runtime:check -- --role webhook
npm run runtime:check -- --role alert
npm run slo:check
```

API 部署后的探针：

- `/healthz`：进程活着以及基本依赖状态，用作 liveness。
- `/readyz`：数据库、迁移、Redis、生产安全配置全部满足后才返回 ready，用作 readiness。
- `/metrics`：只给监控系统访问，不是客户 API。
