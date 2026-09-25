# 多窗口并发 与 豆包匿名面 —— 接口设计（对接用）

面向 scrm 侧（`ruoyi-geo` 的 OneGl 客户端）。本文是**契约**：字段、语义、约束、错误码与对接顺序。
实现落地后以生成的 `openapi.json` 为准，本文负责把「为什么这么设计」说清楚，避免两边对同一个
字段的理解不同。

日期：2026-09-24　状态：待实现 / 待评审

---

## 一、两个能力，一句话说明

| 能力 | 语义 | 对数据的影响 |
| --- | --- | --- |
| **多窗口并发** | 同一个账号同时跑 N 个浏览器（各有独立进程、页面、指纹） | 只影响速度与风控暴露面，**不改变观测面** |
| **豆包匿名面** | 豆包在无登录态下采集 | **改变了观测面**：匿名答案与登录答案是两类样本 |

这两件事必须在契约上分开表达，因为它们对下游统计的含义完全不同：前者可以随时调，后者一旦混进
同一份提及率就会让那个数字描述谁都不准。

---

## 二、观测面：`surface` 字段 + 服务端开关

### 2.1 为什么不做成新的 provider

直觉方案是注册一个 `doubao-anonymous` adapter。**当前实现没这么做，原因是一个真实的限制**：

`getProviderAdapter('doubao')` 返回的是**同一个对象**，`requiresStoredAuth` 是它身上的一个
getter。也就是说「豆包是否匿名」是 **provider 级的全局状态**，不是账号级的。若按那个方案注册第二个
adapter，它和 `doubao-web` 会指向同一份豆包采集实现，两者对同一批账号给出互相矛盾的观测面判定 ——
更糟的是，一旦在部署侧打开匿名开关，**现有的登录态豆包账号会一起变成匿名**，历史数据的面被静默改写。

所以当前契约是：

- **服务端开关**：`ONEGL_DOUBAO_ANONYMOUS=1` 决定这条实例上的豆包走不走匿名（默认关）。
  它是**全局**的，一个实例同时只支持豆包的一种观测面。
- **接口里的 `surface` 字段**：调用方显式声明它想要哪一面，服务端用运行期事实校验。
  声明 `anonymous` 但开关未开时返回 `422 surface_not_enabled`，而不是静默按登录态跑。

这样「文档承诺的」和「实现响应的」是同一件事：接口不承诺一个实现做不到的 adapter id，而是承诺
一次会被真正校验的意图声明。

> **对接约束**：`provider` 字段继续用 `doubao` / `qianwen`。旧客户端不传 `surface` 时行为与现在
> 完全一致。
>
> 若将来需要**同时**跑「豆包登录态」和「豆包匿名」，那要把观测面从 provider 级降到账号级
> （每个 account 行带 surface），那是一次真实的重构，不是加个枚举值 —— 见第七节「未决」。

### 2.2 怎么切到匿名（方案 A 的完整操作）

**切换点是部署侧的一个环境变量，不是接口参数：**

```bash
# /data/onegl/deploy/.env.production
ONEGL_DOUBAO_ANONYMOUS=1     # 缺省 / 0 = 现有登录态行为
```

改完重建镜像并重启 worker（配置随容器重启生效）。开启后豆包整条线走匿名，**scrm 侧不需要任何改动**：
`task-routes.js` 在 `requiresStoredAuth === false` 且调用方没给 `account_ids` 时，会自动创建一个
`anon-doubao` 通道账号来承载额度、队列与冷却（匿名也得有个被治理的对象，否则就是一条无人看管的采集路径）。

⚠️ **这是全局开关，影响是整条豆包线**：

| 影响项 | 开匿名后 |
| --- | --- |
| 现有登录态豆包账号（4 个） | 全部变成匿名面，`login_state` 记为 `anonymous` |
| 历史 run 的 `login_state` | **不改写**（历史是历史），但同一账号前后两段数据的观测面不同 |
| 账号额度 | 豁免（匿名不吃每日/每小时上限） |
| 并发槽位 | 与其他账号一致（`ONEGL_ACCOUNT_SLOTS`） |
| 登录绑定流程 | `auth-sessions` 对豆包不再有意义（不再需要扫码） |

所以**不要在一个批次跑到一半时切换**：那个批次的样本会横跨两个观测面，提及率无法解释。

### 2.3 匿名批次的账号建议

虽然服务端会自动供给 `anon-doubao` 通道账号，但给匿名批次**单独注册账号**（如 `doubao_anon_01`）
仍然值得做：队列与配额都按 `account_key` 组织，独立账号让「匿名那条线」在队列深度、额度、失败率上
都是可单独观察的对象，出问题时不用去翻登录态账号的日志。

---

## 三、多窗口并发：`account_slots`

### 3.1 参数

| 字段 | 位置 | 类型 | 默认 | 约束 |
| --- | --- | --- | --- | --- |
| `account_slots` | `POST /v1/accounts` 请求体 | integer | 2 | 1–4 |

放在账号注册上而不是批次上，理由：并发度是**这个账号的运行方式**（它决定冷启动开销、指纹轮换节奏、
风控暴露面），而不是某一次采样的属性。同一个账号在不同批次上用不同并发，会让两批数据的采集条件
不可比。

**两个面的默认值分开**（服务端环境变量，非接口字段）：

| 环境变量 | 作用面 | 生产当前值 |
| --- | --- | --- |
| `ONEGL_ACCOUNT_SLOTS` | 所有账号的默认 | 1（登录态维持原有串行保护） |
| `ONEGL_ANONYMOUS_ACCOUNT_SLOTS` | 只覆盖匿名面 | 2 |

之所以不合成一个值：两面的风险不对称。匿名面多开只多几个同出口 IP 的访客；有凭证的账号多开是
拿账号本身去试平台风控，而后者尚未实测。合成一个值时，「想给千问加速」会强制把豆包也放开，
而那个决定需要单独的证据。

### 3.2 服务端行为

```
账号注册时传的 account_slots  >  ONEGL_ANONYMOUS_ACCOUNT_SLOTS / ONEGL_ACCOUNT_SLOTS
```

- 账号注册/更新时把 `account_slots` 落到 `service_account_bindings`；
- worker 为每个账号建一个容量为 N 的信号量，N 个槽位各持有独立的浏览器 session；
- 指纹轮换**按槽位独立计数**（`runs.request_slot`），所以 N 个槽位不会在同一位置一起重启。

### 3.3 ⚠️ 有凭证账号的代价（必须在契约里写明）

账号级 advisory lock 原本把同一个登录态**串行化**，防止它被平台并发击穿。`account_slots > 1` 时
那把锁按槽位放行，保护让位给吞吐。所以：

- **匿名面**（`doubao-anonymous` / `qianwen`）：代价为零，它没有可被击穿的登录态；
- **登录态**（`doubao` / `yuanbao`）：平台会看到同一账号多设备同时提问，风控可能收紧。

接口上用一个显式字段记录这个知情选择，而不是靠默认值默默承担：

```json
POST /v1/accounts
{
  "account_id": "doubao_main_01",
  "provider": "doubao",
  "account_slots": 2,
  "acknowledge_concurrency_risk": true     ← 登录态 + slots>1 时必填
}
```

少这个字段时返回 `422 concurrency_risk_not_acknowledged`，而不是静默降级到 1 或静默接受。

---

## 四、豆包匿名面：批次与执行

### 4.1 创建批次

```json
POST /v1/batches
{
  "project_id": 147,
  "name": "绍兴肩颈腰腿调理-100问-豆包匿名",
  "size": 100,
  "method": "stratified",
  "platform": "doubao-anonymous",
  "accounts": ["doubao_anon_01", "doubao_anon_02"],
  "repeats": 1,
  "start": true
}
```

`accounts` 列多个匿名账号时，服务端为**每个账号各建一条队列**，天然并行（这是现有的跨账号并行，
与 `account_slots` 的账号内并行是两个维度，可以叠加）。

### 4.2 观测面标记（下游必须据此分表）

每条 `run` 都会带：

| 字段 | 匿名面取值 | 登录面取值 |
| --- | --- | --- |
| `login_state` | `"anonymous"` | `"account"` |
| `provider_access` | `"scraped"` | `"scraped"` |
| `provider` | `"doubao"` | `"doubao"` |

报表接口 `GET /v1/executions/{id}/report` 的 `observation_surfaces` 会列出本批次实际出现过的面。
**下游统计规则**：`observation_surfaces` 含两个值时，提及率必须分开算，不得合并 —— 这一点在
`qianwen-web.js` 的注释里有实测依据（匿名面与登录面的引用深度不同）。

### 4.3 匿名面的额度与失败语义（实测）

| 现象 | 千问（已实测） | 豆包匿名（探测中） |
| --- | --- | --- |
| 每轮可用条数 | 4 条 | 待测 |
| 撞墙后静置 | 20–30 分钟 | 待测 |
| 登录墙信号 | 跨域 iframe（passport.qianwen.com） | 页面出现登录要求文案 |
| 失败是否可重试 | **否**（提问已提交，重试会重复提问） | 同左 |

因此接口不提供「自动重试撞墙任务」的开关 —— 那会重复提问、污染样本。撞墙后的任务是 `skipped`，
由人工决定是补跑还是放弃。

---

## 五、接口清单（新增/变更）

### 变更 1：`POST /v1/accounts`

```yaml
AccountCreate:
  type: object
  required: [account_id]
  properties:
    account_id:   { type: string, minLength: 1 }
    provider:
      type: string
      enum: [doubao, doubao-anonymous, qianwen, yuanbao]   # 由 supportedProviderIds() 派生
      default: doubao
    label:        { type: [string, "null"] }
    account_slots:
      type: integer
      minimum: 1
      maximum: 4
      default: 2
      description: 同一账号同时运行的浏览器数。>1 时账号级串行锁按槽位放行。
    acknowledge_concurrency_risk:
      type: boolean
      default: false
      description: provider 需要登录态且 account_slots>1 时必须为 true，否则 422。
```

新增错误：

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 409 | `account_surface_conflict` | 同名 `account_id` 已注册在另一个观测面 |
| 422 | `concurrency_risk_not_acknowledged` | 登录态 + `account_slots>1` 但未确认风险 |

### 变更 2：`GET /v1/accounts`

响应每个账号增加三个派生字段（**只读，不返回任何凭据**）：

```json
{
  "account_id": "doubao_main_01",
  "provider": "doubao",
  "surface": "account",                  // account | anonymous
  "account_slots": 2,
  "slots_in_use": 1,                     // 当前占用中的槽位（来自 worker 心跳）
  "requires_stored_auth": true
}
```

`slots_in_use` 来自 worker 心跳（`concurrency_per_account` / `account_slots`），
`GET /v1/accounts/{accountId}/inflight` 里也补上，便于判断「现在能不能安全回收」。

### 变更 3：`POST /v1/batches`

```yaml
BatchCreate:
  properties:
    platform:
      type: string
      enum: [doubao, doubao-anonymous, qianwen, yuanbao]
      description: 采纳批次时使用的平台。doubao-anonymous 会以匿名面采集并落 login_state=anonymous。
    # 其余字段不变
```

新增错误：`422 account_platform_mismatch` —— `accounts` 里混了属于另一个观测面的账号。

### 新增：`GET /v1/capabilities`

给对接方一个「这台服务现在到底支持什么」的探针，避免靠试错：

```json
{
  "providers": [
    { "id": "doubao",           "provider": "doubao",  "requires_stored_auth": true,  "max_slots": 4 },
    { "id": "doubao-anonymous", "provider": "doubao",  "requires_stored_auth": false, "max_slots": 4, "enabled": false },
    { "id": "qianwen",          "provider": "qianwen", "requires_stored_auth": false, "max_slots": 4, "enabled": true }
  ],
  "worker": { "account_slots_default": 2, "account_parallelism": 1 },
  "notes": [
    "豆包匿名面需要通过 ONEGL_DOUBAO_ANONYMOUS=1 在部署侧启用，enabled=false 表示该实例尚未开启"
  ]
}
```

`enabled` 是运行时事实（读环境变量），不是配置声明 —— 界面据此决定是否把「匿名」选项置灰，
而不是让用户点了之后再收到 409。

---

## 六、对接顺序（建议）

1. scrm 侧先接 `GET /v1/capabilities`，把「豆包匿名」选项做成受 `enabled` 控制的可选项；
2. 账号注册接 `account_slots` 与 `acknowledge_concurrency_risk`（先只在匿名账号上开 2）；
3. 批次创建接 `platform: doubao-anonymous`；
4. 报表侧按 `observation_surfaces` 分开统计，**这是唯一不可省的一步** —— 前三条只是取数，
   这一条决定取到的数能不能用。

---

## 七、未决与风险

| 项 | 状态 |
| --- | --- |
| 豆包匿名面的每轮额度、撞墙静默时长 | **探测中**，未测出前不建议把匿名批次当成主力通道 |
| 豆包允许匿名提问（平台侧） | 已实测通过：提交后返回 952 字完整答案，无登录墙 |
| 登录态账号 `account_slots=2` 的平台反应 | 未测。建议先在单个豆包账号上跑 10–20 条观察，再全量 |
| 匿名面与登录面的样本能否合并 | **不能**。需要报表侧明确分区 |
