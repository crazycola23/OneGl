/**
 * 「提交后一个字符都没出现」的判据 —— 两个平台共用。
 *
 * 语义：平台**静默吞掉**了这次请求。它和「慢」是两件不同的事，分界就在答案有没有涨过：
 * 涨过 = 平台在写（哪怕很慢，历史上见过 40–99 分钟的慢响应），全程为 0 = 根本没在写。
 * 加预算救不了后者，只是白占槽位 —— 2026-09-26 批次 68 有 6 条拖满 900 秒而 answerSeen
 * 全程为 0，按 6 条算白占约 78 分钟。
 *
 * 现场长什么样（千问批次 68 的 artifact，逐条比对）：
 *
 *   generating: true    页面停在 `answer-receiving-card` + spinner
 *   answer card 数 = 0  答案卡片从未出现（question card = 1，提问确实送出去了）
 *   login / captcha / accessRestricted 全 false，页面上没有任何拒绝文案
 *
 * 也就是前端已经建立流式接收状态，服务端一个 token 都不推，UI 会一直转下去。
 * 完整记录见 `docs/FINGERPRINT_ROTATION_LESSONS.md` 第十一节。
 *
 * 导出成纯函数是为了能被单独测试 —— 它直接决定要不要主动放弃一条**已经提交**的样本，
 * 而判错的代价不可逆（重跑就是重复提问）。
 */
export function isSilentlyDropped({ answerLength, firstTokenSeen, waitedMs, windowMs }) {
  // 出现过答案就永久关闭这条路径：页面重渲染会让某次采样读到 0，那不是「没答」，
  // 拿它当判据会把慢任务误杀。这是本判据唯一可能造成不可逆损失的地方。
  if (firstTokenSeen) return false;
  if (answerLength > 0) return false;
  return waitedMs >= windowMs;
}

/**
 * 读容忍窗配置。
 *
 * 下限 30s：低于它的窗口会把「平台正在排队/预热」误判成吞请求。
 * 默认值由各平台自己给：千问是 180s（实测首字延迟 8/8/8/8/6/50/97 秒，取尾部 97s 的约 1.85 倍）；
 * 豆包沿用同一个保守值 —— 它自己的 `[doubao] first-token` 日志攒出分布之后再各自校准，
 * 不要凭「豆包是流式、应该更快」这类直觉把它调小。
 */
export function noFirstTokenWindowMs(envName, fallbackMs, minMs = 30_000) {
  const raw = Number(process.env[envName]);
  return Number.isInteger(raw) && raw >= minMs ? raw : fallbackMs;
}
