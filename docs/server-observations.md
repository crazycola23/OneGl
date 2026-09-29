# 服务器实测记录（2026-09-29）

这份文件记录服务器上跑过的实测结论，以及**哪些数据不能当证据**。
写下来是因为批次 69 的数据已经把我带偏过一次，不想再来第二次。

## 环境

- 服务器 `192.168.2.110`，`/data/onegl`，容器 `onegl-app-onegl-{api,worker,webhook,monitor}-1`
- 部署基线：本地 `ce89b1c` 全量同步，镜像构建成功，12 项关键符号核对通过
- 数据库 ledger 已到 `0034`，但 `migrations/` 目录当时只到 `0029`（文件与账本脱节，本次已补齐）

## 能正常工作的部分

| 场景 | 结果 |
|---|---|
| 千问并发 3 问（走 API） | 3/3 成功，citations 4/7/12，`brand_mentioned` 正常 |
| 豆包单问 | 成功，first-token 9s，答案 534 字 |
| 豆包串行 3 问（间隔 90s） | 3/3 成功，答案 311/423/511 字 |

千问与豆包的采集链路都是通的。

## 不要拿批次 69 当证据

**批次 69（豆包 50 问，25 成功 25 失败）是被人为重启打断的，不是采集逻辑失败。**

判据（`runs` 表 `sampling_batch_id=69`）：

- 批次自身 `finished_at` 是 `19:58:42`，但多条 run 的 `finished_at` 是 `21:14:50` / `23:11:48` / `00:41:24` / `00:56:25`——**结束时间晚于批次结束数小时，甚至跨天**。真实耗时是分钟级（如 `19:33:20 → 19:33:51`），那些数小时的记录是进程被断开后写回的残留。
- 因此 `error_code` 的分布（`DOUBAO_SUBMISSION_FAILED` 16 次、`PAGE_CHANGED` 6 次等）**全部不可信**。
- `DOUBAO_SUBMISSION_FAILED` 里那 3 条 `previous-turn-still-busy` 的 `initialUrl` 相同（`chat/38444025636716034`），曾被我误读成"卡在同一会话反复重试"；实际上那 3 个 run 的 `started_at` 是 19:08 / 19:11 / 19:14，正好每分钟一条，是提交节流按 60s 节奏顺序投喂的正常结果。

结论：判断豆包健康度只能看**未被打断的单次执行**（见上表），不要看跨重启的批次聚合。

## 已确认的真实缺陷（独立复现，非批次 69）

`startCleanConversation`（`src/doubao.js:373`）在真实页面上找不到「新对话」按钮：

- `getByRole("button", { name: "新对话", exact: true })` 命中 **0** —— 真实按钮文案带快捷键后缀，页面上是「新对话\nCtrl Shift K」
- `getByText("新对话", { exact: true })` 命中 1，但点击不触发，`clickedNewConversation: false`
- 兜底走 `openDoubao` 重开首页，停在 `https://www.doubao.com/chat/`（**裸根路径，无会话 ID**）

这是**直接实测复现**的（先提问进到 `chat/local_2551562481942238`，再调该函数，观察到
`clickedNewConversation: false` 且 URL 退回根路径），与批次 69 无关。

尚未量化：豆包能扛住多少并发。之前起的并发矩阵实验（`并发=2/间隔=0` 那一组）被我
手动停掉，只跑了一半没有结果，所以**豆包的并发上限目前是未知数**，不要写成"并发是问题"
或"并发没问题"。

## 运维要点

- Redis 需要鉴权，`redis-cli --scan` 在 `NOAUTH` 时返回空 → 循环不执行 → 计数 0 → **门禁假通过**。
  必须先 `PING` 得到 `PONG` 再看队列。
- 宿主机没有 `node`，一切 node 计算要借容器：`docker exec <c> node -e '...'`。
- PowerShell 会抢先展开 `$(...)` 和 `"`，远程命令一律写成 `.ops/*.sh` 再 `scp` 过去执行，不要内联。
- `launchBrowserSession(config, { ignoreStoredAuth })` 第二个参数才是开关；`config` 必须
  从 `loadConfig()` 取，手搓会漏字段，量出来的现象不能代表线上。
- API 凭据在 `service_api_clients`（sha256），不在 `.env`；冒烟用临时 key，跑完 `revoked_at=now()`。
- 临时探针文件由 root 通过 `docker cp` 放进容器，容器内以 onegl 用户运行删不掉；
  它们在容器 `/tmp`，重建即消失。
