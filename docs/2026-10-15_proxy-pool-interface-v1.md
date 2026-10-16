# OneGl 通用代理接口设计 v1

按两个输入源设计：固定代理列表，以及通过 GET/POST API 提取代理。供应商接口通过声明式字段映射转换成 OneGl 的统一记录；浏览器、账号和队列不依赖某家供应商的返回格式。

状态：**两个输入源（`static` / `http_api`）都已落地**（见下），调度与自证也已接通；第 3 节的管理接口与第 4 节的跨进程租约/共享预算仍是设计。示例地址使用 `.invalid`，`enabled=false`；复制示例不会获得真实代理。

**实现状态（2026-10-16）**

| 已落地 | 位置 | 证据 |
|---|---|---|
| `ONEGL_PROXY_POOL_FILE` 入口、`static` 输入源、`*_env` 成对凭据、必需池禁用/缺失即阻断（不回退直连） | `src/proxy-pool.js`、`src/proxy-record.js`、`src/config.js` | `test/proxy-pool.test.mjs` 14 项 |
| 按 `(平台, 账号, 槽位)` 稳定分配 —— 槽位进哈希键，出口数够时同账号多开不共用 IP | `src/proxy-pool.js` `selectExit` | 同上；`test/proxy-http-api.test.mjs` 的 pooled 用例 |
| `http_api` 提取源：GET/POST、4 种认证、JSON 点路径映射与 `text_lines`、业务码判失败、寿命单位显式声明、密钥不进日志 | `src/proxy-source-http-api.js` | `test/proxy-http-api.test.mjs` 17 项（含查询串密钥脱敏） |
| `per_session` 模式：每次会话取一个没用过的出口，用完即弃（短效轮换池） | `src/proxy-pool.js` | 同上 |
| 提取的单飞锁 + 最小刷新间隔 + 失败也记时间 | `src/proxy-pool.js` `refreshInventory` | `test/proxy-http-api.test.mjs`「4 个并发只打供应商 1 次」 |
| 代理贯通 Camoufox 与 Playwright 启动、Chromium/Firefox 分支 | `src/browser.js` | `node tools/probe-proxy-egress.mjs --expect <ip>` |
| 会话启动时的出口自证（`connect` / `browser` / `off`），验不过即失败并摘掉该线路 | `src/browser.js` `verifySessionEgress`、`src/proxy-egress.js` | `test/proxy-egress.test.mjs` 9 项 |
| 出口 IP 落库：`runs.proxy_pool_id / proxy_exit_id / proxy_mode / observed_egress_ip` | `migrations/0035_run_proxy_egress.sql`、`src/db/persist.js` | 迁移与 `persistRun` 参数 |
| 池子体检（池子到货后第一条要跑的命令） | `tools/proxy-pool-check.mjs` | `test/proxy-pool-check.test.mjs` 4 项：全绿 / 直连泄漏 / 隧道不可用 / 池子禁用 |
| 出口自证探针（含故障注入），走完整浏览器 | `tools/probe-proxy-egress.mjs` | 真实出口 `125.64.14.30`；死代理 `NS_ERROR_PROXY_CONNECTION_REFUSED`，无直连泄漏 |

尚未落地、不要当成可用能力：Redis 租约与跨进程共享预算、平台/出口维度的限流、`policy` 段的所有字段、第 3 节的五个管理接口、`openapi.json` 变更。池子的调度状态是**进程内**的（见 §4 的说明），两个 Worker 各持一份。

顺带修掉一处 Windows 专属启动阻塞：Camoufox 的指纹配置在 Windows 按 2047 字节切分成 `CAMOU_CONFIG_1..6`，而 `browser.js` 只解析第 1 段，导致本机每次启动都抛 `JSONDecodeError`（Linux 单段无此问题）。现改为按序号拼接全部片段。

**1. 固定两个接入形式**

| 接入形式 | 输入 | 认证 | 行为 |
|---|---|---|---|
| `static` | `server` 列表；例如 `http://host:port` | 无认证，或独立的用户名/密码环境变量引用 | 稳定分配已有代理，不向供应商提取新地址。 |
| `http_api` | HTTPS GET/POST 的 JSON 或文本响应 | 提取接口的认证与代理本身的认证分别配置 | 低库存时刷新候选地址，规范化、校验并探测后再供任务选择。 |

默认优先支持 HTTP CONNECT 代理访问 HTTPS 目标。无认证的 SOCKS5 作为可选协议；第一版不接受带用户名/密码的 SOCKS5 配置，后续通过具体引擎的兼容性测试再开放。不能把「目标网站是 HTTPS」误写成要求代理入口一定使用 `https://`。协议细节依据 Playwright 当前依赖的类型定义和 HTTP CONNECT 规范。

固定网关也可作为 `static` 入口；如果供应商实际上会按请求随机换出口，它就不满足 `fixed` 声明。需要供应商特有 session 参数的网关，后续只扩展输入源适配器，不在浏览器里猜用户名后缀或查询参数。

配置入口拟定为 `ONEGL_PROXY_POOL_FILE`，指向本地配置文件。实际配置放在现有忽略目录 `local/` 中；仓库仅保存两个公开样例：`examples/proxy-pool.static.example.json` 和 `examples/proxy-pool.api.example.json`。未设置入口时保持现有直连行为；指定 `required=true` 的池后，如果池禁用、无可用出口或加载失败，则延后/阻断相应平台任务，不能悄悄回退直连。

**2. 供应商接口的请求、映射与统一结果**

API 样例使用下面的假定接口。它是 OneGl 通用适配器的默认示范，不宣称所有供应商都使用同一地址或字段名。

```http
GET /api/getip?num=2&format=json HTTP/1.1
Host: proxy-provider.example.invalid
Authorization: Bearer <由 ONEGL_PROXY_PROVIDER_TOKEN 读取>
```

示例 JSON 响应：

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": "vendor_exit_a",
        "ip": "198.51.100.10",
        "port": 3128,
        "expire_time": "2026-10-15T12:30:00Z"
      }
    ]
  }
}
```

这里的固定时间仅用于格式示范，运行时必须拒绝已经到期或剩余有效时间不足的地址。

| 配置组 | v1 支持内容 | 校验与语义 |
|---|---|---|
| `request` | `method=GET/POST`、HTTPS `url`、`query`、POST `body`、`timeout_ms` | GET 不允许 body；默认超时 10 秒；拒绝 URL 内嵌凭据。请求仅使用管理员配置的来源。 |
| `request.auth` | `none`、`bearer_env`、`header_env`、`query_env` | 后两者另填 `name`，值通过 `env` 读取；不将密钥直接写入样例。URL 查询认证必须脱敏，不能把完整 URL 打进错误日志。 |
| JSON `response` | `success.path/equals`、`items_path`、`fields`、`default_scheme`、`expiry_format` | 示例从 `data.list` 取数组；根数组用空路径。字段映射采用对象属性点路径，不运行表达式、不使用 eval。HTTP 成功不等于业务 `code` 成功。 |
| 文本 `response` | `format=text_lines`、`default_scheme`、默认认证和显式稳定性声明 | 每行 `host:port` 或 `[IPv6]:port`；去空行、去重，拒绝不明确的 `ip:port:user:password` 拼接格式。 |
| `stability` | `fixed` 或 `until_expiry` | 这是输入源的明确能力声明。`until_expiry` 必须提供可信失效时间；时间格式支持 ISO 8601、Unix 秒、Unix 毫秒，不能自动猜单位。有效期不明不按永久稳定处理。 |

JSON 字段映射允许 `id`、`host`、`port`、`scheme`、`expires_at`、`username`、`password`。映射的每条记录必须有 host 和合法端口；scheme 缺省时使用明确配置的 `default_scheme`。username/password 要么成对提供，要么使用 `default_auth`，不得拼出半套认证。响应里的明文认证只在服务端受控处理，保存时转成加密的凭据引用。

统一后的内部记录示例：

```json
{
  "proxy_id": "px_01",
  "revision": 1,
  "pool_id": "shared_web",
  "source_id": "vendor_exit_a",
  "server": "http://198.51.100.10:3128",
  "credential_ref": "proxy-credential:px_01:1",
  "expires_at": "2026-10-15T12:30:00Z",
  "stable_until": "2026-10-15T12:30:00Z",
  "observed_egress_ip": null,
  "observed_at": null,
  "state": "unverified"
}
```

供应商返回的 host 不是已经验证的出口 IP。通过受控地址从实际浏览器探测后，才能填写 `observed_egress_ip`。相同出口、不同入口仍合并计量；端点 ID、认证版本和实际出口身份分别存储。`fixed` 模式允许失效时间为空，但它依然受本地租约和健康检测约束。

刷新由池级单飞锁保护，多个 Worker 不重复购买/提取同一批代理。示例目标可用库存为 2、最大库存为 50，正常刷新间隔至少 30 秒；这些是本系统的试点参数。先清理过期库存，再按缺口请求；请求数量及过量返回的处理由适配器约束，不能让供应商响应无限放大内存或费用。

供应商 API 的 429 按其 Retry-After 冷却。超时后的再次提取可能重复计费，默认不自动重试未确认结果的提取请求；只有明确无计费副作用或支持幂等键的输入源才开启重试。候选记录解析失败返回明确原因，不能将成功响应降级成含糊的「池为空」。

**3. OneGl 管理接口**

沿用现有 `/v1/admin/` 管理入口及管理员鉴权。响应错误保持现有 `{error, message, details}` 形式；新路径只写在本设计中，不加入现有已发布 `openapi.json`。这里管理的是共享基础设施，不允许普通租户直接配置任意供应商 URL 或读取凭据。

| 方法与路径 | 请求 | 成功响应 | 语义 |
|---|---|---|---|
| `PUT /v1/admin/proxy-pools/{poolId}` | 本文配置对象；路径 ID 必须等于 `pool_id` | `200 {pool_id, revision, enabled}` | 校验后建立新配置版本；改变来源/认证不热修改正在运行的会话。 |
| `GET /v1/admin/proxy-pools/{poolId}` | 无 body | `200 {pool_id, revision, config, counts, operations}` | 返回脱敏配置和最近操作状态，不返回凭据值、认证头或包含密钥的完整 URL。 |
| `POST /v1/admin/proxy-pools/{poolId}/refresh` | `{}`，加 `Idempotency-Key` | `202 {operation_id, state:"queued"}` | 入队刷新/验证，结果可从 GET 的 operations 读取；相同 key 和 body 返回原操作，body 不同返回 409。 |
| `GET /v1/admin/proxy-pools/{poolId}/health` | 分页参数 `cursor`、`limit` | `200 {endpoints, platform_egress, next_cursor}` | 分开返回线路健康和各平台出口冷却，避免一处业务限制冻结整个池。 |
| `POST /v1/admin/proxy-pools/{poolId}/drain` | `{reason}`，加 `Idempotency-Key` | `202 {accepting_new:false, active_leases, operation_id}` | 立即停止新任务租用，等待在途任务结束；不强杀正在生成的回答。排空后保留配置，重新启用需显式配置更新。 |

PUT 更新现有池需要 `If-Match` 对应当前 revision，避免两处配置互相覆盖；首次创建使用 `If-None-Match: *`。版本不符返回 412，缺少必需的条件头返回 428。幂等记录保存至少 24 小时，过期后客户端应视为新操作，而不是凭旧 key 假定不会执行。

错误样例：

```json
{
  "error": "proxy_lifetime_too_short",
  "message": "代理稳定时间不足以完成本次任务",
  "details": {
    "retryable": false,
    "required_remaining_ms": 1140000,
    "actual_remaining_ms": 45000
  }
}
```

管理侧错误分为配置错误（400/422）、权限错误（401/403）、版本/状态冲突（409/412/428）、上游服务错误（502/504）和库存不可用（503）。异步 refresh 的运行错误存入 operation，不在已经返回 202 后伪装成同步 HTTP 错误。

`proxy_lifetime_too_short` 首先排除的是当前候选地址，调度器可以选择其他满足寿命要求的地址。整批地址都不满足任务预算时返回明确的不可用原因，不能通过反复提取相同短寿命产品无限重试。

**4. Worker 的租约、提交许可与生命周期**

Worker 不通过 HTTP 管理接口去获取每个任务的代理。内部会话调度模块直接复用现有 Redis、PostgreSQL 和浏览器工厂。对外主要提供 `acquire`、`finish`，并通过获得的 lease 暴露一次提交前许可检查：

```typescript
// 设计契约示意，尚不是可导入的运行代码。
type AcquireResult =
  | { state: "ready"; lease: SessionLease; session: BrowserSession; runtimeConfig: RuntimeConfig }
  | { state: "deferred"; retryAt: number; reason: string }
  | { state: "blocked"; reason: string; requiresManualAction: boolean };

acquire({ provider, accountKey, accessMode, runToken, attempt, maxRunMs }): Promise<AcquireResult>;
lease.beforeSubmit({ submissionId }): Promise<SubmitPermitResult>;
finish({ leaseId, ownerToken, submissionId, outcome }): Promise<void>;
```

会话绑定键是 `(provider, accountKey, accessMode)`，缓存还带槽位和代理 revision。账号身份从既有任务和鉴权上下文解析，不信任用户随便提交的账号字符串。一个出口可以同时服务不同平台；预算同时检查平台总量、账号和 `(provider, observed_egress_ip)`。换出口、换 Worker、刷新库存或开新批次都不清零这些预算。

`acquire` 的幂等身份为 `(runToken, attempt)`，并带当前 Worker 所有权。认证流程使用独立的 auth-session 身份。第一次预算预检不通过时直接延迟任务，不占浏览器槽位或长时间占用数据库连接。获得会话后，provider 在真正点击发送前调用 `beforeSubmit` 原子领取一次性许可；已经发出或无法确认是否发出的提交仍占额度。许可不能跨代理 revision 或过期租约使用。

`submissionId` 标识一次真实提交意图，例如 `runToken:attempt:submitIndex`。同一次提交的重复处理不重复扣款/扣额度；新的实际重提必须使用新的身份并重新计量。读取到提交结果不确定时，记录 uncertain，不能因数据库里暂时没有答案就自动重新发送。延迟等待不消耗采集重试次数。`finish` 幂等释放本任务占用，健康浏览器继续缓存，不等于每次关闭浏览器。

本地所有权租约与供应商代理寿命是两回事。示例中所有权租约为 120 秒，每 30 秒续期；长任务可以持续续期，但不能延长供应商实际失效时间。任务开始前必须满足：

```text
实际剩余稳定时间 >= 预计启动预算 + maxRunMs + 收尾余量
```

示例 `start_margin_seconds=120` 是收尾/时间误差余量，启动预算另外根据运行环境的测量值计入。租约的 fencing token 单调递增；旧 Worker 在失去所有权后不能继续提交或覆盖新状态。已经发出的外部请求无法靠锁撤回，必须保存为在途/不确定状态，不能让新 Worker 立即重提。

代理故障只影响线路状态；平台 429 影响对应平台/出口或账号预算；验证码、登录失效和访问限制沿用人工恢复流程。明确网络连接故障且尚未提交时，允许最多 1 次备用线路尝试；切换前再次核对账号绑定及剩余预算。不会把同一个账号立即转移到新出口来清除已有的限制状态。

若代理出口在运行中意外变化，停止派发新提交，保留当前任务证据，待任务结束后重新验证绑定。源配置修改和 drain 同样遵守任务边界。浏览器构建与 `runOnePrompt` 必须使用 acquire 返回的同一份 runtimeConfig，避免浏览器走代理而落库/诊断又使用丢掉代理信息的二次 `loadConfig(account)`。

**5. 落地顺序与验收**

| 顺序 | 产物 | 必须验证 |
|---|---|---|
| 1 | 配置解析、static/http_api 两个输入源、规范化记录 | JSON 与文本映射、业务失败、认证成对、IPv6、过期地址及单位明确；日志无凭据。 |
| 2 | 浏览器代理参数贯通 | 使用本地测试代理和受控网站验证实际出口、HTTP 认证、长连接、换 context、必需代理失败不直连；无需真实厂商即可开发。 |
| 3 | Redis 租约和共享提交许可 | 两个 Worker、同厂商多账号共享出口、不同厂商独立预算、重复领取、进程崩溃和租约失效；不重复提交或清零预算。 |
| 4 | 五个管理接口与既有鉴权 | 普通租户无法管理基础设施，配置并发更新有版本校验，刷新幂等且可查询，排空不打断在途任务。 |
| 5 | 小规模真实线路验证 | 连接延迟、实际出口稳定时间、网页答案与引用质量、代理流量及冷启动成本；异常按已定义范围暂停。 |

配置样例的并发与预算是保守的试点值，不是任何厂商公布的额度。`platform_hourly_limit` 和 `platform_daily_limit` 对每个平台独立生效，并跨该平台所有代理和账号累计；账号既有上限同时生效，取更严格条件。`host_max_browsers` 才是多个厂商共同占用的本机资源限制。

本接口设计不修改现有代码，也不启用真实代理。现在可以先实现配置解析、输入源适配及本地代理测试，不必等待供应商文档；将来拿到服务地址后，优先通过配置改 URL、认证方式、响应路径和寿命格式。只有供应商存在特殊签名或独有会话协议时才新增该供应商的适配器。

接口依据：本项目 Playwright 1.63.0 的 `types.d.ts` 代理字段、`src/api/http.js` 错误封装、`src/api-server.js` 管理入口，以及前一份路线图中的官方资料。常见 HTTP 代理参数与「供应商取 IP API」分开设计；后者不是统一的行业标准。

---

**6. 池子到货后的接线清单**

按顺序做，每一步都有可证伪的产出。跳过任何一步直接跑实验，就等于把「代理没通」记成「平台风控」——
2026-10-16 的 `125.64.14.30` 就是这么被误读过一次：一个带混杂变量的瞬时对照，差点被当成
「机房段信誉差」的采购依据。

| # | 动作 | 位置 / 命令 | 通过判据 |
|---|---|---|---|
| 1 | 写池子文件 | `local/proxy-pool.json`（本机）或服务器 `/data/onegl/local/proxy-pool.json` | `enabled=true`；`source.kind` 与供应商给的形式对上（提取链接 → `http_api`） |
| 2 | 填凭据 | 提取接口的 key 与出口的用户名/密码**分开**，只进 env | 解析通过；错误信息里看不到明文密钥 |
| 3 | 出口体检 | `node tools/proxy-pool-check.mjs --full --as --json` | 全部可用；不同槽位拿到**不同**出口 IP；`leaked_direct_ip=false` |
| 4 | 看 AS 归属 | 上一步 `--as` 的输出 | 记下是家宽段还是机房段。这一项在验收文档 §7.1 仍未定案，别拿它单独下采购结论 |
| 5 | 打开开关 | `ONEGL_PROXY_POOL_FILE`；同时把 `ONEGL_MAX_ACCOUNT_SLOTS`、`ONEGL_ACCOUNT_DAILY_LIMIT` 放到实验起点 | 重启后 worker 启动日志里出现池子那一行 |
| 6 | 浏览器级证明 | `node tools/probe-proxy-egress.mjs --expect <上一步的 IP>` | 页面读到的出口 IP 与池子分配的一致；四个平台站点可达 |
| 7 | 单条真实采集 | 1 条匿名任务 | `runs.observed_egress_ip` 有值，且等于第 6 步那个 IP |
| 8 | 开跑容量实验 | 按 `docs/2026-10-16-anonymous-capacity-acceptance.md` | 结论按**实际出口 IP** 归因，而不是按平台与账号 |

第 3 步与第 6 步验的不是同一件事，两个都要做：

- 第 3 步（`proxy-pool-check`）不起浏览器，0.5 秒一个出口，验的是**线路**：配置能不能解析、
  每次 acquire 是否拿到出口、出口是否真能把流量送出去、有没有回退直连。
- 第 6 步（`probe-proxy-egress`）走完整浏览器，验的是**浏览器**：Playwright 的 proxy 选项
  是否真的落到了 Camoufox 的启动参数上。少了这一步，「配了代理」和「浏览器走了代理」之间
  那段距离就没有被观测过。

池子挂掉时的行为是刻意设计的：出口验不过 → 这次启动失败 → 该线路从池子里摘掉 →
下一次冷启动换一个出口。摘掉的是**线路**，不是重发当前任务的许可。
