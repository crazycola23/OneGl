# 千问匿名基线作废记录（2026-09-22 六次采样）

2026-09-24 复核。**结论：2026-09-22 落盘的 6 条千问匿名 run 不能作为 profile 的测量依据**，其中 4 条被记为 `success` 的记录是假成功。原始 artifact 一律保留，本记录只作标注。

## 对象

`.onegl/runs/` 下 `provider=qianwen`、`loginState=anonymous` 的 6 条：

| run | 记录状态 | 答案字符 | 耗时 | 实际判定 |
| --- | --- | --- | --- | --- |
| `run_20260922T063217576Z_d0ee76a7` | success | 129 | 7s | 截断，作废 |
| `run_20260922T063500528Z_38eb3e80` | success | 141 | 7s | 截断，作废 |
| `run_20260922T072918446Z_17b71685` | success | 306 | 7s | 截断，作废 |
| `run_20260922T075726333Z_c5d3d26f` | success | 90 | 7s | 截断，作废 |
| `run_20260922T072345450Z_657d63e6` | failed | — | 273s | `UNKNOWN_ERROR` / Page crashed |
| `run_20260922T073214877Z_93d17906` | failed | — | 10s | `UNKNOWN_ERROR` |

## 证据

**1. 四条 success 全部截断。** 用 `src/answer-quality.js` 的 `looksTruncatedAnswer` 逐条判定，4/4 命中；同期 19 条豆包记录 0/19 命中，所以坏的是千问这一路，不是判据本身。结尾分别为 `…国新能源汽车销量冠军。 核心`、`…油耗低至3.63L/100k`、`…比亚迪断层领跑：累计销量超1`、`…品牌销量排名供参考。 2`。

**2. 四条全部 7 秒完成。** 豆包同期为 24–79 秒。7 秒完成一次深度检索在物理上不成立。

**3. `c5d3d26f` 的 DOM 观察与它的运行记录自相矛盾。** 同一次 attempt 下：

- `dom-observation.json`：`answer.visibleNodeCount = 0`，5 个 `answerSelectors` 的 count 全为 0，`sources.visibleBlockCount = 0`，`sessionSignals.generating = true`，`promptEchoCount = 0`；
- `run.json`：`status = "success"`、90 字符答案、4 条带 URL 的引用、`conversationResetConfirmed = true`。

`dom-observation.json` 里的 `assumptions.answerSelectors` 是 `.md-box-root`、`[data-testid="message_text_content"]` 等 —— **豆包的选择器**。用豆包的选择器扫千问页面，扫到 0 个答案节点，平台仍在生成中，却被记成一次成功采集。

**4. 落盘的页面里没有更多内容。** `page.html` 剥离标签后可见文本共 1258 字符，答案确实只到 `…供参考。` 为止，末尾拖着一个孤立的 `2`。

**5. 对账失败没有否决。** `d0ee76a7` 的平台自陈为参考 6 篇、捕获 0 篇，`citationState = count_mismatch`，状态仍是 `success`；`17b71685` 为 14/4。

## 影响

`src/providers/qianwen-web.js` 头部写着 profile 的 `login` / `chat` / `citation` 取值是「Measured on 2026-09-22 over six anonymous captures」。**这 6 条就是那 6 次**，所以这句话的测量基础已作废。

其中 `chat` 的选择器在 2026-09-23 已用出货引擎（部署容器里的 Camoufox）重测并替换（`answer-common-card` / `qk-markdown`），该次重测本记录不否定，它才是当前依据。仍然失去依据的是上文那句对 9/22 基线的整体引用。

**本记录不否定 `burstPrompts: 4` / `burstPauseMs: 25min`。** 那两项的依据是 2026-09-23/24 的批次 58/60/63/65（见同文件 111–118 行），那批数据不在本机，本次未复核。

## 处置

- 原始 `run.json` / `attempts/` 一律未改，按「重试与证据不被覆盖」的既有约定保留；
- 4 条作废 run 目录内加 `INVALIDATED.md` 指针；
- 后续统计与 profile 复核不得引用这 6 条；千问匿名面的选择器与完成判据需在出货引擎上重测。

## 相关

完成判据本身的缺陷（静默窗口按轮询次数表达：名义上「30 轮 × 1500ms」像 45 秒，实际含 `page.evaluate` 往返约 92 秒，且不受控）已在 2026-09-24 改为毫秒语义并加长，见 `src/qianwen.js` 的 `ANSWER_QUIET_MS` / `ANSWER_QUIET_FLOOR_MS` 与 `test/qianwen-completion-window.test.mjs`。新窗口值是按全库时长分布估的保守值，**尚未经一轮真实采集标定**。
