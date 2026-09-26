# 指纹轮换与远程部署的踩坑记录（2026-09-24）

本次目标：让千问在使用时**每 2 次提问重置一次指纹、打开新窗口**，并保证 100 条采样能完整跑完。

过程中遇到的问题里，**只有一类是真缺陷（会让功能静默失效）**，其余是工具链与判断失误。分开记，因为它们的排查成本完全不同。

---

## 一、静默失效类：功能看着在跑，实际一次都没生效

这三个的共同点是**不报错、日志正常、表面上一切健康**，只有去数事件条数或核对运行时值才看得出来。

### 1.1 两个轮换共用了一个会被清零的计数器

`prepareWindow` 里两处判定原本读同一个 `session.contextPrompts`：

- 换窗口（`rotateContext()`）**会把这个计数归零**（它问的是「当前这个窗口服务过几次提问」）；
- 换身份（改指纹）也在读它。

千问的 `promptsPerWindow = 1`，于是**每一轮都换窗口、每一轮都把计数抹平**，身份计数永远停在 0，`shouldRotateIdentity` 永远返回 false。

`ONEGL_WINDOW_RESET_EVERY=2` 配着、开关看着是开的，`fingerprint-rotated` 事件**一次都没出现过**。

**判据**：`grep -c 'event=fingerprint-rotated'` 为 0，而同批任务已经跑了十几条。

**修法**：两者用**各自独立的量**，并且在注释里把三者的区别写清楚（见 `src/worker.js` 的 `prepareWindow` 文档块）：

| 判定 | 读什么 | 何时归零 |
| --- | --- | --- |
| 换窗口 | `session.contextPrompts` | `rotateContext()` 后 |
| 换身份 | 批次内已服务提问数（数据库） | 换批次 |

### 1.2 计数器活不过一次进程重启

改成独立计数器后仍有问题：内存计数**每次 worker 重启都从 0 重数**。

于是「每 2 条换一次指纹」实际变成**每 3 条** —— 重启后第 1、2 条共用一个身份，第 3 条才换。这个偏差不报错，只是让「第几条数据用哪个指纹」的对应关系悄悄漂移，**而指纹轮换的全部意义就是打断这种对应关系**。

本次部署前后重启了四次，这个偏差必然已经发生过。

**修法**：判据改成**可从数据库推导**的量 —— 该批次内这个账号已服务的提问数（`promptCountForBatch`），轮换发生在 `已服务数 % 每N === 0` 这个边界上。

这样「第几条用哪个身份」在任何重启点都算得出来，从任意位置接上、落点与没重启过完全一致。line 上的实测：

```
event=fingerprint-rotated ... window_reset_every=2 prompts_served_before_rotation=30
event=fingerprint-rotated ... window_reset_every=2 prompts_served_before_rotation=32
```

`runs` 表用的是 `ON CONFLICT (local_run_id) DO UPDATE` 的 upsert，**重试同一格不会留重复行**，所以 `count(*)` 就是「服务过的提问数」，不需要去重。

**教训**：凡是「每 N 次做一次 X」的调度，只要 N 的节奏需要跨重启保持，计数就不能只活在内存里。而**可推导优于可存储** —— 从既有事实（批次内的 run 数）推导，比新增一个会不同步的状态列更稳。

### 1.3 判定「静置能否解除限制」时算错了时间

观察到失败从 10:51 开始、最后一条成功在 10:50:01、耗时 2490 秒，据此推断「墙在 11:31 解除，而失败在解除后仍持续」。

**这是错的**：那个 2490 秒是**进行中任务被中断**留下的假象（`COALESCE(finished_at, now())` 把在跑的任务算成了已完成）。真实证据在日志里 —— `retryAt` 到了之后**第一条立刻撞墙**，静置两次都没解除。

**教训**：判断某次等待是否奏效，要看**等待结束后的第一条结果**，不要用含 `COALESCE(finished_at, now())` 的耗时去倒推时间线。

---

## 二、额度相关的两处认知修正

### 2.1 千问的「无限额度」早就在代码里

`safety.js` 有一道无凭证面豁免：`isCredentialFreeSurface(provider)` 为真时，直接跳过每日/每小时上限、最小运行间隔、失败冷却和平台突发节奏。

`qianwen-web` 声明 `requiresStoredAuth: false`，所以**它本来就不吃账号额度**。

**生产证据**（比读源码有力得多）：

```
千问账号 runs_today = 108，而 ONEGL_ACCOUNT_DAILY_LIMIT = 40
→ 账号仍为 healthy、仍在正常出结果
```

判定函数的实测输出：

```
千问（今日已跑 99999 次）: {"kind":"available","reason":null,"retryAt":null}
豆包（今日已跑 99999 次）: {"kind":"temporary","reason":"已达每日上限 40 次"}
```

### 2.2 豆包的额度本来就是按单账号算的

`classifyAccountState` 读的是 `accounts` 表里 `(account_key, provider)` 那一行的 `runs_today`，不存在全局共享计数器。多个豆包账号各自独立计数。

`runs_last_hour` 的子查询**确实带了 provider 过滤**（曾被怀疑漏掉，核对后是有的）。

**教训**：动手改「限制」之前，先去运行时把判定函数的返回值打出来。「代码里写着限制」和「这个平台实际被限制」是两件事 —— 前者可能有一条你还没读到的豁免分支。

---

## 三、工具链踩坑（与业务无关，但每次都耗时间）

### 3.1 Windows 上没有可用的 SSH 密码通道

`sshpass` / `plink` 均无，OpenSSH 客户端不接受管道密码，目标机只有 `publickey,password`。解法：用 `ssh2` 写一个 `exec` / `script` / `put` / `get` 的封装（`.ops/remote.mjs`）。

### 3.2 PowerShell 会先吃掉 bash 的 `$(...)` 和引号

`node remote.mjs exec "… $(date …) …"` 里的 `$(date …)` 在**到达 ssh 之前**就被 PowerShell 解释成了 `Get-Date`。

**修法**：凡是有变量、引号嵌套或 SQL 的命令，一律走 **``script`` 动作**（把本地 bash 文件通过 stdin 交给远端 `bash -s`），不要拼内联字符串。

内联 SQL 更糟：它要穿过 `PowerShell → node → ssh → bash → docker exec → psql` 六层转义，任何一层吃掉一个引号，拿到的就是空值。**曾因此误判「指纹轮换失效」，实际只是命令没传对**。改用 `psql -f -` + `--file` 传 `.sql` 文件后只有一层。

### 3.3 `--` 既被本工具解析、又被 bash 当选项

`remote.mjs` 早期把自己命令行里的 `--count 5` 当成自己的 flag 吃掉，远端脚本收不到 ——「提升 5 个」**静默变成「提升 1 个」**，不报错。

加了 `--` 透传后又踩到 bash：`bash -s -- x` 里的 `--` 被 bash 当作自己的选项（`invalid option`），而 `bash -- -s` 又把 `-s` 当文件名。

**最终形态**：`script` 动作不传任何参数；需要参数时用 `exec "bash -s <位置参数>" --file <脚本>`。**位置参数不会歧义**。

### 3.4 compose 的 `up -d` 会把整个 overlay 拉进来

用 `-p onegl-app -f scrm-ordered.yml -f onegl-overlay.yml up -d --no-recreate`（**不指定服务名**）时，compose 把 scrm 全家桶都纳入了 reconcile，开始构建 `ruoyi-*` 的 build definition。

这次靠「镜像没变所以没重建」侥幸没出事，但**范围不能交给 compose 对「什么算变化」的判断**。

**修法**：永远显式列出服务名 + `--no-deps`。

### 3.5 测试沙箱是按函数抽取的，不是整个模块

`test/browser-orphan-reaping.test.mjs` 用 `extractFunction` 把 `browser.js` 里的几个函数抽进 `vm` 沙箱，沙箱只注入 `readdir` / `readFile` / `rm` 和一个 `process` 替身 —— **没有 `os`、没有 `path`**。

因此：

- 在那些函数里用 `os.tmpdir()` 或 `path.join()` → 沙箱里 `ReferenceError`；
- 新增一个模块级 helper 再调用它 → 同样 `ReferenceError`，因为**抽函数是按单个 `function` 声明做的，helper 不会被一起带进沙箱**。

这就是把 `/tmp` 改成 `os.tmpdir()` 时弄坏那三个用例的原因。**修法**：需要的表达式内联在函数体内，用 `process.env.TMPDIR || "/tmp"`（语义等价：Node 的 `os.tmpdir()` 在 Linux 上读的就是 `TMPDIR`）。

### 3.6 验证脚手架本身会骗人

两次把「验证失败」当成「代码有问题」，其实都是脚手架的问题：

- 第一次：暂存区里是**改动前**的文件（改了本地却没重新上传），于是在测旧代码；
- 第二次：`docker cp` 之后没核对容器内哈希，复制成功与否无从判断。

**修法**：验证脚本里先打印**容器内目标的 sha256**，再跑断言。先证明「在测的东西是对的」，再结论。

### 3.7 不要用主项目的 package.json 装运维依赖

在项目根跑 `npm install ssh2` 会把 `ssh2` 写进 `package.json` 的依赖里 —— 项目依赖不该被一个运维脚本污染。（已清理，依赖留在 `.ops/` 下。）

---

## 四、判断失误类

### 4.1 「静置有效」被误认为「额度是硬限制」

早期看到「静置 25 分钟后能再跑 4 条」，判断为「额度是结构性的、只能等」。但实际上静置解除的是**短时突发限制**，而**登录墙是另一回事**（持续 25 分钟以上，静置两次都没解除）。

两者混在一个 `burstPauseMs` 里表达，是这条限制看起来像「不可绕过」的原因。

### 4.2 单条耗时是隐藏的产能上限

千问正常 98–100 秒/条，但**平台限流时能拖到 40–63 分钟**（批次 65 的实测：`dur_s` 2400–3800），超标就被判 `DOUBAO_TIMEOUT`。而千问的失败是 **no-retry**（提问已提交，重试会重复提问）—— 一条撞死就少一条数据。

所以「100 条能否跑完」不只取决于额度，还取决于**单条超时预算是否够宽**。`DOUBAO_TIMEOUT_MS` 从 480000 提到 900000 就是为了这个。

### 4.3 把静默窗从 150s 拉到 180s，反而制造了超时（2026-09-24）

**结论：`ANSWER_QUIET_MS` 当场回退到 150s。**

推理链当时看起来无懈可击：窗口越长，越能容忍平台的长暂停，于是越不容易截断。既然截断率 72% 是主要问题，而窗口的代价只是时间，那把 150s 提到 180s 应该是「更保守 = 更安全」。

实测结果相反 —— 部署后第一条采集在 **1014 秒**（16.9 分钟）后被 `DOUBAO_TIMEOUT` 判死。

原因在判据本身的结构：它要求**答案长度连续 150s（或 180s）一动不动**。窗口越长，这个条件越难满足，而平台在生成过程中的微变（流式补字、引用块重排）本来就可能跨越整个窗口。于是窗口不是"更宽容"，而是变成一条**必然拖到超时预算尽头**的路径 —— 从「等答案写完」翻转成「等不到任何可以收尾的时刻」。

**教训**：这个窗口的代价不是线性的。超过某个点，它从"更安全"翻转到"必然失败"。所以它必须贴着实测数据走，不能凭"更保守更安全"去外推 —— 而 150s 这个值本身就带着一行 "not a calibrated value"，回退就是尊重那行字。

附带确认了一条因果：**同一次根因（窗口）可以表现为两种相反的症状** —— 窗口太短是「截断」（留半句话），窗口太长是「超时」（一条都留不下）。调这个参数时两个方向都要盯着。

---

## 五、无凭证面的并发：把「不需要登录」这个前提用起来

千问是匿名通道（`requiresStoredAuth: false`），这个概念在 `safety.js` 里已经用来豁免额度，但**并发**这条路上还有三道锁没让开：

| 层 | 原状 | 改法 |
| --- | --- | --- |
| 队列消费并发 | `WORKER_CONCURRENCY_PER_ACCOUNT = 1` 硬编码 | 改为按账号取 `slotsFor(provider)` |
| 账号级跨进程锁 | `onegl-account:${provider}:${accountKey}` 强制串行 | 无凭证面让开（`credentialFree`），仍占全局槽位 |
| 会话对象 | `sessions` 按 accountKey 只存**一个** session | 会话键加槽位后缀，每槽位一份独立浏览器 |

第三层是真正的硬伤，而且要明确一点：**「无凭证」解决的是权限问题，不是隔离问题**。同一账号并排跑 N 个浏览器时，每个槽位仍必须有自己的浏览器进程、页面和指纹 —— 否则两个任务会共用同一个 `page`，一个在等答案生成、另一个往里塞新提问。

几个实现上的注意点：

- **槽位由信号量分配，不能从任务序号推导**：`slot = gate.acquire()` 返回槽位号，保证同一时刻一个槽位只属于一个任务。用序号推导（如 `selectionIndex % N`）会在任务被 delay 重排、被 promote、批次续跑时静默错位。
- **每账号一个槽位池，不是全局大池**：共用池子会让豆包的总并发被千问的槽位数抬高。按账号分开，「几个登录态共享一个额度」才天然成立。
- **凭证免的全局槽位上界要按并发数给足**：只给 1 个的话，即使账号锁让开了也拿不到槽位，并发仍然停在 1（这个坑很隐蔽，现象是「配置改了但完全没效果」）。
- **槽位要落库**（`migrations/0028` 的 `runs.request_slot`）：指纹轮换的计数必须按槽位分开，否则 N 个槽位会在同一位置一起触发轮换 —— 等于把 N 个浏览器同时重启。

**实测收益（2026-09-24，千问 #66）**：

| 指标 | 并发前（1 槽位） | 并发后（2 槽位） |
| --- | --- | --- |
| 单条耗时 | 268s | 267 / 268s（不变） |
| 每条平均间隔 | 350s | 约 175s |
| 答案完整性 | 无截断 | 无截断（1269 / 1152 字） |

单条耗时不变而间隔减半，是并发正确的标志；如果单条耗时明显变长，说明槽位没真正隔离（两个任务在抢同一个 page 或 CPU）。

### 5.1 迁移被既有校验和问题挡住（遗留）

`npm run db:migrate` 在 `0023_saas_batch_result_identity` 上中止：

```
Migration 0023_saas_batch_result_identity changed after it was applied.
```

但核对结果是矛盾的 —— 本地文件的 sha256 与数据库记录**完全一致**（`e8b22cbc…`），而**镜像内**那一份是 `66d36362…`。所以不一致发生在镜像/构建上下文这一层，与本次改动无关。

本次处置：`0028` 是纯增量 DDL（`ADD COLUMN` + `CREATE INDEX`），所以手动执行并补了一条带真实字节校验和的迁移记录，而不是去改校验机制本身。

**遗留**：`0023` 的镜像内版本为何与工作树不同仍未查明，`migrate.js` 目前会在它上面中止 —— 下次需要迁移时得先解决这个，否则每次都要手动绕。

### 5.2 一次自作自受的事故

把 `ANSWER_QUIET_MS` 从 150s 拉到 180s 后，第一条采集在 1014 秒被 `DOUBAO_TIMEOUT` 判死（详见 4.3）。教训已写在那一节，这里只补一条操作层面的：**部署脚本里「重建镜像」和「重启容器」必须绑在一起**。我曾单独跑了一次 cutover，容器重启了但挂的还是旧镜像 —— 白丢一条在跑的任务却没换来新代码。

---

## 六、并发不被平台挂起：定位触发条件，而不是加开关

并发上线后立刻出现新故障：**两个槽位同时 job-start，同时跑到预算耗尽**。

```
i74 slot=0  job-start → 1015s DOUBAO_TIMEOUT
i75 slot=1  job-start →  993s DOUBAO_TIMEOUT
```

这是本轮最容易被误判的一处。两个反直觉的点：

**一、它不是「平台变慢了」。** 同一个批次的成功记录耗时稳定在 **268s 完全没变**。平台变慢会表现为耗时普涨；这里成功的那批一秒没变，失败的成对出现 —— 说明平台对「同一时刻的多个请求」的响应被**挂起**，而不是整体降速。

**二、它不是「并发本身」的错。** 单槽位下同样的任务 268–388s 正常完成。所以可以并发、可以多开浏览器，**只要别在同一瞬间提交**。

于是解法的形状就定了：不是关掉并发，而是**把提交时刻错开**。

### 6.1 错峰的实现坑：读时间戳 vs 串行队列

第一版想当然的写法是「读上次提交时间 → 算差值 → sleep → 写回」：

```js
const target = lastAt + intervalMs;      // 两个任务读到同一个 lastAt
await sleep(target - Date.now());         // 算出同一个 target
lastAt = Date.now();                      // 于是又撞在一起
```

并发进来的两个任务会读到**同一个旧值**、算出**同一个目标时刻**，最后一前一后照样同时提交 —— **节流配置了、日志也打印了、行为却完全没变**。这正是本文反复出现的那类故障：配置生效、行为没变，且每一步看起来都对。

正确形态是把「取时间戳」串行化成队列，让第二个任务必须排在前一个写完之后才算自己的时刻：

```js
const waitMs = await new Promise((resolve) => {
  gate.tail = gate.tail.catch(() => undefined).then(() => {
    const now = Date.now();
    const target = gate.lastSubmitAt ? gate.lastSubmitAt + intervalMs : now;
    const wait = Math.max(0, target - now);
    gate.lastSubmitAt = now + wait;
    resolve(wait);
  });
});
```

首条不等待（`lastSubmitAt` 为 0 时直接放行）：批次开头那条没有「上一格」要错开，让它白等一个间隔只是降低启动速度。

### 6.2 结果

| 配置 | 结果 |
| --- | --- |
| 2 槽位，无错峰 | i74/i75 **成对 TIMEOUT**，各烧满 ~1000s |
| 2 槽位 + 60s 错峰 | i83/i84 **都成功**（523s / 390s），`submit-throttled wait_ms=55069` |

代价是单条从 268s 变成 390–523s，**但这个代价本来就存在** —— 并发超时烧掉的是 20 分钟加上一条数据。买回来的是「不再丢数据」。

### 6.3 事后止损与事前预防要分开

同一件事做了两层，但它们不是重复：

- **预防**（`ONEGL_SUBMIT_INTERVAL_MS`）：让触发条件不出现。稳态工作，正常时无日志噪音。
- **兜底**（`noteConcurrencyTimeout`）：仍撞上并成对超时时自动降到单槽位。

兜底判据刻意收紧，避免把平台偶发的慢响应也算进来：只认 `slots>1` 时、`TIMEOUT` 且 `answerSeen`（超时时已渲染字符数）极小的那种 —— **有答案说明平台在慢慢写，那是平台慢，撤并发帮不上忙**。

关键观察指标：**兜底一直不触发，才是预防成功的证据**。本次 19 条以上全程 0 次降级。

### 6.4 一处必须写进代码的取舍

`slots > 1` 时账号级 advisory lock 按槽位放行（`distributed-lock.js`），保护随之让位给吞吐。这个代价对**匿名面为零**（没有可被击穿的登录态），对**有凭证的账号是拿账号本身去试风控**。所以在配置项、接口字段（`acknowledge_concurrency_risk`）和代码注释三处都写明，而不是靠默认值默默承担。

### 6.5 静默窗口的两端都是坑（与 4.3 呼应）

同一根因可以表现为两种相反症状：窗口**太短**是截断（留半句话），**太长**是超时（一条都留不下）。调这个参数时两个方向都要盯着 —— 这是本文第二次出现这个结论，而两次都是靠实测才发现的。

---

## 七、并发下「浏览器被关闭」：一次典型的 check-then-act 竞态

并发上线后出现了一个**全新的失败模式**，和之前的超时/登录墙都不同：

```
UNKNOWN_ERROR: keyboard.type: Target page, context or browser has been closed
```

浏览器在任务输入问题时已经被关闭。排查过程里最关键的一步是**先补观测点**：原来的
`job-start` 日志不记录槽位，于是「两个并发任务是不是共用了同一个浏览器」这个问题**无法回答**。
补上 `take-slot` 事件后立刻看到槽位分配是对的（`slot=0` / `slot=1`），从而把怀疑范围从
「槽位分配器」缩小到「会话生命周期」。

### 7.1 根因：`sessions.get` 与 `sessions.set` 之间是 async 的

```js
async function getSession(account, slot) {
  const existing = sessions.get(identity);
  if (existing) return existing;              // ← 检查
  const session = await launchBrowserSession(...);   // ← 60~120 秒的 await
  sessions.set(identity, session);            // ← 写入
  return session;
}
```

两个并发调用（同一账号的槽位分配若因为任何原因重复，或轮换与取会话交叠）会**都看到「没有会话」、
各自 launch 一个**。后写入的覆盖前者，**先启动的那个浏览器就此脱离 `sessions` 管理** ——
下一次 `closeSession` / 指纹轮换关掉的是它，而正在用它的任务就报 `Target page ... has been closed`。

这是教科书式的 check-then-act：**检查与写入之间隔着一次 async 操作**，而表本身就是为「只有一个」
而设的。这类缺陷在单槽位下永远不会出现，所以它只在并发打开后才暴露。

### 7.2 修法：把「正在创建」也放进表里

```js
const inflight = sessionCreating.get(identity);
if (inflight) return inflight;                 // 第二个调用复用第一次的创建
const creating = (async () => { ... })();
sessionCreating.set(identity, creating);
creating.catch(() => undefined).finally(() => {
  if (sessionCreating.get(identity) === creating) sessionCreating.delete(identity);
});
return creating;
```

两个细节容易写错：

- **`creating.finally(...)` 返回的是新 Promise**，不能把结果赋回 `creating` —— 那样表里存的就
  变成带清理的那个（且它本身是 rejected 的），第二个调用会拿到一个必然失败的 Promise。
- **`closeSession` 必须同时删 `sessionCreating`**：否则一次 close 之后，仍在进行的创建会把
  自己写回表里，让一个已经被关掉的槽位「复活」成有会话。

### 7.3 代价与收益

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 单条耗时 | 320–523s（含重复启动与排队） | **264 / 307s** |
| 「浏览器被关闭」失败 | i88、i91 | **0** |

提醒：这次故障一开始被我误判为「平台对并发请求的惩罚」，因为它的表象与超时很像（都是并发下才出现）。
区分点在于**错误码不同**：超时是 `DOUBAO_TIMEOUT`，这是 `UNKNOWN_ERROR` 且消息里有
`has been closed`。看到新错误码时要先假定「这是我改出来的」，而不是继续沿用一个已经成立的解释。

---

## 八、引用采集：两个自创枚举值造成的「假性抓不到」

这一节记一次排查方向被彻底带偏的经历，以及一个必须记住的结论。

### 8.1 现象与真因

**现象**：批次 66/67 的 `runs.captured_citation_count` 恒为 0，看起来「引用一条都抓不到」。
据此我怀疑过：页面改版、引用在跨域 iframe 里、需要点击展开、需要高级爬虫 —— 全部错误。

**真因**：落库时被 schema 拒绝，而我加的两个字段值是自己编的：

```
Unsupported sourceType value(s): icon.     The schema only accepts 'visible' or 'retrieved'.
Unsupported relationStatus value(s): resolved. The schema only accepts 'matched' or 'unresolved'.
```

`src/qianwen.js` 里我写了 `relationStatus: "resolved"` 和 `sourceType: "icon"` —— 两个都不在
`db/persist.js` 的枚举里。采集**成功了**，是**写不进数据库**。而失败被记账成
`job-db-error → 数据库写入失败`，同时 `captured_citation_count` 停在 0，于是症状与「抓不到」完全一样。

**教训**：新增字段值之前先读 schema 的允许集合，不要凭语义直觉造词。
`persist.js` 里这两个 Set 就是权威：`ALLOWED_RELATION_STATUS` / `ALLOWED_SOURCE_TYPES`。

**排查提示**：`captured=0` 有两种完全不同的原因 ——「没采到」与「采到了但没写进去」。
区分方法只有一个：**看 worker 日志里有没有 `job-db-error`**。有，就是落库问题，别再查页面。

### 8.2 引用在页面上到底长什么样（实测）

千问把引用渲染成**一排 favicon**，不是文本、不是链接、也没有可展开的列表：

```html
<div class="reference-wrap-iEjeb3" id="reference-link-anchor-{uuid}">
  <div class="link-title-igf0OC">
    <div class="search-icon-list-i55_Lz">
      <div class="search-icon-item-iAr43k"><img src="http://s2.zimgs.cn/ims?...key={base64}&sign=..." class="search-icon-img-zUSoZ2"></div>
      ...
    </div>
    <span class="text-content-W61W05">10篇来源</span>
  </div>
</div>
```

`key=` 是 base64 编码的 URL，**解码后是 favicon 图片地址**（`.png` / `.ico`），不是文章地址：

```
aHR0cHM6Ly9jZG4uc20uY24vdGVtcC8...  → https://cdn.sm.cn/temp/....png
aHR0cHM6Ly9ndy5hbGljZG4uY29tL0wx... → https://gw.alicdn.com/L1/....ico
```

### 8.3 正解：展开「N篇来源」，数据在 data-click-extra 里

**文章级来源拿得到**，入口就是答案下方那个「N篇来源」按钮。两个关键点，我连续几轮都栽在这里：

**一、必须先 `scrollIntoView` 再点。** 那个元素在页面下方（实测 `top≈1310`，视口之外），
Playwright 的 `locator.click()` 会一直等它进入视口然后超时。我因此连试了 `force:true`、
`text=` 定位、原生 `click()` 全部失败，最后错误地归因为「点不开」。

```js
el.scrollIntoView({ block: "center" });
el.click();        // 必须先滚进视口，否则步骤永远超时
```

**二、数据在 `data-click-extra` 属性里，不在文本也不在 href 里。** 展开后每个来源是
`div[data-c="refer_panel"]`（id 形如 `deep-think-source-card-{uuid}-{n}`），其属性是一段 JSON：

```json
{"url":"https://www.meipian.cn/5nr0zu4n","title":"爱分享的沐沐的美篇",
 "ref_url":"https://www.meipian.cn/5nr0zu4n","refer_num":"1","display_scene":"answer_rag"}
```

展开后 `anchorCount` 仍然是 0 —— 链接根本不在 `<a>` 上。只扫 `<a>` 永远拿不到。

**实测效果**（2026-09-25 验证）：平台自述 9 篇 → 抓到 10 条（9 条来自面板 + 1 条图标兜底），
`citationState = ok`。抓到的示例：

```
雪球网     『浙江绍兴哪家spa开放？2024正规持证场所清单+避坑指南（本地人亲测）』
大众点评   禅悦汇足道（越城店）60号服务好
大众点评   这家沈园堂性价比最高
寻医问药   沈灏_副主任医师_绍兴市中医院推拿科
绍兴网     看病像点奶茶！绍兴这些公立医院，都上美团了
```

**三、必须轮询等待渲染，不能只试一次。** 这是修复里唯一「手动测试通过、线上却完全不生效」的一段。
现象：同一份代码，在采集返回后再等 2.5 秒手动展开能拿到 10 条；而线上批次 `refer_panel=0`，一条都没有。

原因是调用时机 —— 这段逻辑挂在 `submitAndWait` 之后，那一刻答案文本虽然稳定了，但「N篇来源」
按钮往往还没渲染出来。`page.evaluate` 里找不到元素就直接返回 false，静默失败。

```js
// 按钮：轮询等它出现（上限 6s）
let opened = false;
const clickDeadline = Date.now() + 6_000;
while (Date.now() < clickDeadline) {
  opened = await clickExpander();
  if (opened) break;
  await page.waitForTimeout(800);
}
if (!opened) return [];
// 面板：同样轮询等条目渲染（上限 6s）
```

**教训**：凡是在「答案刚完成」这一刻去读 UI 的新逻辑，都要假设 UI 还没渲染完。
一次性的 `evaluate` 加 `.catch(() => false)` 会把「还没出现」和「不存在」变成同一个结果，
而这两者需要完全相反的处理。

### 8.4 两条被推翻的结论，以及为什么该被推翻

**第一条：「平台没触发深度搜索就没有来源」。** 我用「带出处块 vs 有 DOM 引用」做相关性统计，
得到 4/4 对 0/150，就断定来源依赖平台是否触发搜索。但那时我**根本没能展开面板** ——
面板一直存在，只是我点不开。用一个失败的采集结果去反推采集机制，结论必然是错的。

**第二条：「匿名面拿不到来源文章 URL」**，依据是对 480KB `page.html` 快照的离线穷举
（href 只有静态资源、无 title、无 .html 结尾 URL）。错在两处：

1. **样本选错**：我穷举的那条答案恰好没触发深度搜索，本来就没有来源面板。
   拿「没有面板」的快照证明「面板里的链接不存在」，是循环论证。
2. **静态快照看不到折叠内容**：面板默认收起，不展开就不进 DOM。而 `page.html` 是采集
   时刻的静态快照，不含交互后的状态。

**教训**：用「穷举快照找不到 X」论证「X 不存在」之前，必须先确认**X 该出现的情境已经被触发**；
用「采集结果里没有 Y」论证「平台不给 Y」之前，必须先排除「是我们没取到」。
这两次我都跳过了这一步，于是把一个采集缺陷记成了平台限制 —— 而这条错误的负面结论差点
让这个功能永远不被修复。

现在引用采集是四路合并，按完整度排序：

| 路 | 来源 | 拿到什么 | 前提 |
| --- | --- | --- | --- |
| 1 | `[data-c="refer_panel"]`（展开后） | **文章 url + 标题** | 平台触发深度搜索 |
| 2 | favicon 图标 base64 解码 | 图标托管域名 | 总是有 |
| 3 | 答案文本出处块 | 篇数 + 关键词 + 来源标题 | 部分答案有 |
| 4 | 页面「N篇来源」徽章 | 篇数 | 总是有 |

**顺带确认离线分析这条路子**：`/var/lib/onegl/runs/<runToken>/attempts/1/` 下有
`page.html` / `dom-observation.json` / `answer.md` / `screenshot.png`。
排查 DOM 问题时先看这份快照，比反复起浏览器探测快得多 —— 探测容器还会和 worker 抢平台额度，
实测两次都在 10 分钟超时。**但它只能回答「当前 DOM 里有什么」，回答不了「展开后有什么」**。

### 8.5 部署脚本的「假成功」

`deploy-15-submit-throttle.sh` 的 FILES 清单里没有 `qianwen.js`。我用它部署引用修复，
日志显示「部署成功」，但容器内代码根本没变（第 629 行仍是旧的 `"resolved"`）。

**做法**：部署后不该只看命令退出码，要**核对容器内文件内容**（grep 关键行）。
`deploy-17-citation-fix.sh` 就是这么写的 —— 末尾直接 grep 枚举值并数非法值出现次数。

### 8.6 artifact 重放会把旧格式的错带回来

修好枚举值之后，重试那些早先失败的任务，却冒出一批新的同类错误：

```
job-db-replay-error error=Unsupported sourceType value(s): icon.
job-db-replay-error error=Unsupported relationStatus value(s): resolved.
```

注意前缀是 **`db-replay`** 而不是 `db-error`。这些任务在更早的时候**已经用旧代码采集成功过**，
结果落在 artifact 里（`/var/lib/onegl/runs/<runToken>/attempts/1/`）。重试时系统为了
**不重复向平台提问**（这是对的保护），选择从 artifact 重放而不是重新采集 ——
而那份 `citations.json` 是旧代码写的，带着 `icon` / `resolved` 两个非法值，于是再次落库失败。

**三个要点**：

1. **改数据结构时要想到已落盘的 artifact。** 它们是不可变的历史事实，新代码的校验器一样会读它们。
2. **`db-replay-error` 与 `db-error` 要分开看**：前者说明数据没重采、是历史格式问题；
   后者说明本次采集的产物不合法。混在一起看会以为修复没生效。
3. **这类任务不值得救。** 救它就得删 artifact 强制重采，而重采等于把同一个问题问第二遍 ——
   和系统自己的保护机制冲突。为几条数据去重复提问，风险大于收益。

### 8.7 一次操作层面的自伤：反复重启会吃掉在跑的任务

为了验证修复，我在批次运行期间反复部署重启 worker。后果是每次重启都把正在跑的任务打成
`job stalled more than allowable limit`，批次 67 因此丢了 7 条（`failed=98`，队列 `wait=0 active=0`
但批次只完成 94/100）。

**这 7 条不是代码问题，是我的操作代价。** 教训是部署要挑批次间隙：
要么等批次跑完，要么接受「这一轮少几条」。反复重启的代价不会体现在部署日志里，
只在事后统计时才看得出来。

---

## 九、部署过程中必须守住的约定

- **范围由参数决定，不由工具判断**：显式列服务名，`--no-deps`。
- **每次改动都留回滚标签**：镜像打 `onegl-*:pre-<动作>-<时间戳>`，文件级备份到 `/root/onegl-backups/pre-<动作>-<时间戳>`。
- **重建镜像会 `--force-recreate`，打断正在执行的那一条**：部署时机选在 worker 空闲（队列 `active=0`）时。本次有一次在跑任务时重启，必然丢了一条。
- **`/data/onegl` 不是 git 仓库**，也没有 `node_modules`（依赖只在镜像里）。所以：同步要用逐文件哈希比对，验证要用「起一次性容器 + `docker cp` 注入待测文件」的方式，不能只读挂载源码目录（那样会盖掉镜像里的依赖）。
- **部署前先跑基线对照**：用**改动前**的镜像跑同一套测试，把「基线就有的失败」和「这次改出来的失败」分开。本次就是靠这个证明那 3 个失败与改动无关（`.github/` 不在镜像内、OpenAPI 构建产物缺失），而 `listProfileDirs` 那个失败是被本次改动修好的。

---

## 十、批次卡死在 running：runs 表是队列的投影，投影会缺行（2026-09-26）

### 10.1 现象

批次 68 停在 100 条里的 89 条：`completed=79 failed=10`，界面 `running` 不再前进，
而 Redis 侧 `wait=0 active=0` —— 队列里早就没有活任务了。

最关键的一处不对称：**队列的 failed 集合里有 21 条，进度只认了 10 条。**

### 10.2 根因

任务的失败点可以落在 `RunStore.createRun` 之前（提交节流、Redis 连接、执行锁），
此时 `runs` 表里连一行都没有 —— 它只存在于队列的 `failed` 集合里。

而 `refreshBatchProgress` 只数 `runs` 表：

```sql
completed = count(status in ('success', 'partial'))
failed    = count(status = 'failed')
```

这 11 条既不算完成也不算失败，`resolveBatchOutcome` 的 `settled` 永远为 false，
批次停在 running 不再前进。

**队列的 failed 集合才是唯一事实来源，`runs` 表只是它的投影。** 投影缺行时，
以投影为准的任何判定都会得出「还没跑完」。

### 10.3 排查路径

顺序本身值得记，它避开了两条弯路：

1. **先看队列计数，再看数据库计数。** `wait=0 active=0` 而状态仍是 running，
   这一对矛盾直接指出「任务不是慢，是没了」——不要再去调超时参数。
2. **用 job id 集合做差集，不要靠计数器推理。** 把队列 `failed + completed` 里的
   `b68_i*` 全收上来（21 + 79 = 100），再与 `runs.run_token` 求差，缺的 11 条立刻现形。
   计数器只会告诉你有 11 条不见了，差集告诉你**具体是哪 11 条**，而"哪几条"才决定怎么救。
3. **不要从「平台问题」查起。** `timeout exceeded when trying to connect` 看着像网络，
   实测 Redis 本身健康（`rejected_connections=0`、内存 4.73M/256M、慢查询最长 11ms），
   是 worker 侧连接池失效。

### 10.4 修法

`src/queue/batch-reconcile.js` 做队列侧对账，`refreshBatchProgress` 只在
`completed + failed < requested` 时才查队列 —— 正常路径整段跳过，不付代价。

两个必须坚持的细节：

- **Redis 读不到时返回 0，不要抛错。** 宁可这一轮少算（下一次事件会再算），
  也不能把还在跑的任务误判成失败从而提前收口批次。
- **不要把差额算成 skipped。** 这些任务确实失败了（job 状态是 failed），记成 failed 才是实话；
  skipped 的语义是「没有产出 Run 的分配」，与它们不符。

### 10.5 恢复分档：按「能否证明提问没发出」，不按「看起来失没失败」

这是本节最该带走的一条。恢复工具 `.ops/recover-batch.mjs` 分四档：

| 分档 | 判据 | 处置 |
| --- | --- | --- |
| never-started | 无 `run.json`（`createRun` 从未调用） | 无条件重跑 |
| empty-answer | 提问已提交、`answerSeen=0` | 需 `--allow-resubmit` |
| state-uncertain | `run.json=running` | 需 `--force-uncertain`，先摘状态 |
| answered | 已拿到答案 | 拒绝执行，只能人工判断 |

判据的锚点是 **`run.json` 在不在**，而不是 `attempts/` 目录在不在。因为
`createRun`（`src/collect/runner.js:319`）发生在 `provider.run`（同文件 `:381`）之前：
「有 run.json」只说明进了流程，**「没有 run.json」才等价于提问绝无可能发出**。

反过来，`attempts/` 目录为空**不能**证明没提交 —— 产物是在 `provider.run` 返回之后写的，
进程在等待回答时被杀，目录一样是空的。这条差点让 `state-uncertain` 被误并进「无条件安全」。

三处值得记住的手法：

- **`state-uncertain` 必须先摘状态再入队，且必须在入队之前全部摘完。**
  `job.retry()` 之后 worker 立刻接手，那时再改 `run.json` 就来不及了。原件改名保留
  （`run.json.abandoned-<时间戳>`），`attempts` 与 `attemptHistory` 一律不动 ——
  事后判断某条数据是不是第二次问出来的，靠的就是这份现场。
- **`job.retry()` 不抛错不等于任务回到了队列**，必须复核 `getState()`。
- **判断「平台没答」还是「采集器没抓到」，去看 `page.html` 里提问的位置。**
  本批次 10 条 `answerSeen=0`，grep 到提问以
  `<div class="message-card-wrap question">…<div class="question-text-card">` 渲染在对话区 ——
  提问确实提交了、答案节点 0 个，是平台没答。若提问只出现在 `textarea` / `contenteditable` 里，
  那才是「填了没发」，两者处置完全相反。

### 10.6 恢复必须自带次数上限

恢复工具是可以反复运行的，而它每跑一次就会把队列里的 `failed` 重新推回去。没有上限，
一条平台侧注定跑不出来的任务（匿名额度用尽、持续被静默拒绝）会被反复重问：每一轮都消耗
一次额度、拉长批次，而失败原因一模一样。**一次足够把「暂时性故障」和「这条就是跑不出来」
区分开**；后者需要的不是再试，是人工判断。

上限落在 `job.data.recoveryCount`，而不是本地产物：

- `RunStore.createRun` 会重建 `run.json`，字段要额外维护才能活过一次重跑；
- **死在 `createRun` 之前的任务根本没有 `run.json`** —— 而它们恰恰是最需要重跑的那一档。
  只有队列这条路径对两类任务都成立。

两个必须守住的顺序：

- **先记账，再 `retry()`。** `retry()` 返回后 worker 可能立刻把任务取走，那时再写 `job.data` 就晚了。
- **回填时要覆盖「排队中 / 运行中」的任务，不能只看 `failed`。** 它们正是上一次恢复推回去的，
  跳过它们等于让每一条都白拿一次额外机会。实测回填时只有 1 条处于非 `failed` 状态，而正是它漏掉了。

实测拦截效果：批次 68 修好后再次运行恢复，`实际回到队列 0/15`，14 条被上限挡住、1 条仍在执行 ——
上限按预期生效，批次稳定停在 `partial`（`completed=85 failed=15`）。

### 10.7 一个被证伪的诊断信号

`dom-observer.js:214` 的 `promptEchoCount` 抓错了元素：它匹配到了输入框的 placeholder
（`userMessages[0].text === "向千问提问"`，className 里带 `placeholder:text-disabled`），
却漏掉了真正的 `.message-card-wrap.question`，于是对**已提交**的提问报出 `promptEchoCount=0`。

它目前只被 `validate.js` 记录、不参与判定，所以没造成误判，但作为诊断信号是失真的 ——
用它来判断「提问有没有送进对话」会得出相反结论。已知未修：改选择器会动到校验口径。

### 10.8 三个工具链坑（这次各花掉一轮）

1. **`bash -s` 传入的脚本里不能用 `docker exec -i`。** ssh 把脚本通过 stdin 交给 `bash -s`，
   而 `docker exec -i` 会读 stdin，抢走尚未被 bash 读取的剩余脚本 —— 表现为输出在某个点之后
   凭空消失、`exit code 0`、看不出任何错误。脚本内一律用不带 `-i` 的 `docker exec`；
   需要 SQL 就内联进 `-c`，不要用 `-f -`。
2. **产物目录在容器里，不在宿主。** `/var/lib/onegl` 是 docker volume
   （宿主侧为 `/var/lib/docker/volumes/onegl-app_onegl-data/_data`），
   在宿主上 `ls /var/lib/onegl/runs` 只会得到一个空目录，很容易误判成「产物没了」。
3. **`runs.id` 是 bigint，不是 `run_<时间戳>`。** 确定性 runId 走 `local_run_id`
   （`run_b<批次>_i<序号>`），别把 `id` 当目录名去拼路径。

---

## 十一、相关文件

- `src/worker.js` —— `prepareWindow`：两个轮换判定的分工与文档块
- `src/accounts/safety.js` —— `identityPromptsAfterRelaunch`（组边界）、`promptCountForBatch`（可推导计数）、`isCredentialFreeSurface` 豁免
- `src/providers/index.js` —— `providerBurstPacing`：`burstPauseMs < 1` 视为关闭而非半声明
- `src/browser.js` —— profile 目录识别（沙箱兼容写法）
- `test/window-rotation.test.mjs` —— 轮换契约（含「重启后网格不变」与「降级不抛错」）
- `test/risk-control.test.mjs` —— 突发节奏的可配置性与失效路径
- `.ops/remote.mjs` + `.ops/deploy-*.sh` —— 远程通道与分阶段部署（`script` 动作、逐文件备份、回滚标签）
- `docs/QIANWEN_BASELINE_INVALIDATION.md` —— 千问匿名基线的作废记录（完成判据缺陷的来龙去脉）
- `src/queue/batch-reconcile.js` —— 队列侧对账：找出「job 已终结但 runs 表无记录」的任务
- `src/queue/batch-status.js` —— `resolveFailedCount`：runs 表缺行时的失败数解析（纯逻辑，可离线验证）
- `.ops/recover-batch.mjs` —— 批次恢复工具：四档分类、`--allow-resubmit`、`--force-uncertain`、`--settle`、`--mark-recovered`；每条任务最多人工恢复 1 次（计数在 `job.data.recoveryCount`）
