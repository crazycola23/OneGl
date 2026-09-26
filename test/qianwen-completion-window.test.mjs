import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isSilentlyDropped, looksSettled } from "../src/qianwen.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, "..", "src", "qianwen.js"), "utf8");

/**
 * Where the old gate actually fired, measured over 51 successful Qianwen runs on 2026-09-24:
 *
 *   20-60s   11 runs,  0 truncated
 *   80-100s  38 runs, 20 truncated
 *   140s+     2 runs,  0 truncated
 *
 * The 80-100s cluster is the capture stopping rather than the platform finishing, so any window at
 * or below it is known to cut answers - that is what makes it the floor, not a preference.
 */
const OBSERVED_CUTOFF_MS = 80_000;

function constantValue(name) {
  const match = source.match(new RegExp(`const ${name} = ([0-9_]+);`));
  assert.ok(match, `${name} was not found as a numeric literal constant in src/qianwen.js`);
  return Number(match[1].replaceAll("_", ""));
}

test("completion is measured in time, not in poll counts", () => {
  // "30 polls" read as 45s at DOUBAO_POLL_MS=1500 but behaved as ~92s, because each poll also pays
  // a page.evaluate round trip. A gate whose length depends on two moving parts cannot be reasoned
  // about, let alone calibrated - which is exactly how the 80-100s cluster went unnoticed.
  assert.ok(
    !/stablePolls/.test(source),
    "the quiet window must not be counted in polls; the poll interval is configuration",
  );
});

test("the quiet window target is longer than the observed cut-off", () => {
  assert.ok(
    constantValue("ANSWER_QUIET_MS") > OBSERVED_CUTOFF_MS,
    `ANSWER_QUIET_MS must exceed the observed ${OBSERVED_CUTOFF_MS}ms cut-off`,
  );
});

test("the floor is not below the observed cut-off either", () => {
  // The floor is what a tight budget gets squeezed down to. If it sat below the cut-off, a small
  // timeout would silently capture fragments - the failure mode this whole file exists to stop.
  assert.ok(
    constantValue("ANSWER_QUIET_FLOOR_MS") >= OBSERVED_CUTOFF_MS,
    `ANSWER_QUIET_FLOOR_MS must not sit below the observed ${OBSERVED_CUTOFF_MS}ms cut-off`,
  );
});

test("the window is clamped to what the timeout can actually fund", () => {
  // Refusing a tight budget outright would take a working deployment off the air; squeezing the
  // window below the floor would reintroduce truncation. So the window is the smaller of the target
  // and what is affordable, and only an unfundable budget is refused.
  assert.match(source, /const quietWindowMs = Math\.min\(ANSWER_QUIET_MS, affordableMs\);/);
  assert.match(source, /if \(affordableMs < ANSWER_QUIET_FLOOR_MS\)/);
  // 两个门读的是 effectiveQuietMs（已收尾的答案用更短的确认窗），而不是裸的 quietWindowMs ——
  // 否则收尾之后仍要按 150s 才放行，把「已收尾」这个信号白算一遍。
  assert.equal(
    (source.match(/quietMs >= effectiveQuietMs/g) ?? []).length,
    2,
    "expected the primary gate and its weaker fallback to both read the resolved window",
  );
  assert.match(
    source,
    /const effectiveQuietMs = looksSettled\([^)]*\) \? answerQuietSettledMs\(\) : quietWindowMs;/,
    "effectiveQuietMs 应当只由「是否收尾」在 settled 窗口与通用窗口之间二选一",
  );
  // settled 窗口必须有下限：低于「平台中途最长停顿」（实测 56s）会让收尾之后的续写被截掉。
  assert.match(
    source,
    /return intEnvValue\("ONEGL_ANSWER_QUIET_SETTLED_MS", ANSWER_QUIET_SETTLED_MS_DEFAULT, 30_000\);/,
    "settled 窗口的可配置化必须带 30s 下限",
  );
});

test("an answer that never rendered cannot satisfy either gate", () => {
  // The fail-closed direction: a page whose answer selectors match nothing keeps answerLength at 0,
  // so the run must reach TIMEOUT rather than return an empty capture as a success. This is the
  // 2026-09-22 failure, where a 7-second scan with zero answer nodes was recorded as success.
  const quietAt = source.indexOf("const quietMs =");
  assert.ok(quietAt >= 0, "the quiet-window computation was not found in src/qianwen.js");
  // Search from the computation onward: an earlier `classifyFailure` call sits in the pre-submit
  // check, and anchoring the slice on that would have cut an empty region and passed silently.
  const loop = source.slice(quietAt, source.indexOf("const reason = classifyFailure", quietAt));

  // 只看「判成功」的门（`return { scan: latest, sentBy }`）。循环里还有两条以 throw 结束的路径
  // —— classifyFailure 和零字提前退出 —— 它们本来就不该带静默窗条件，混进来会让断言失去意义。
  const gates = [];
  const returns = /return \{ scan: latest, sentBy \};/g;
  let hit = returns.exec(loop);
  while (hit) {
    const before = loop.slice(0, hit.index);
    const condStart = before.lastIndexOf("if (");
    const cond = before.slice(condStart, before.indexOf(")", condStart) + 1);
    gates.push(cond);
    hit = returns.exec(loop);
  }
  assert.ok(gates.length >= 2, "expected the primary completion gate and its weaker fallback");
  for (const condition of gates) {
    assert.match(condition, /latest\.answerLength > 0/, `success gate without an answer requirement: ${condition}`);
    assert.match(condition, /quietMs >=/, `success gate without a quiet-window requirement: ${condition}`);
  }
});

test("a request the platform silently drops is abandoned instead of waited out", () => {
  // 2026-09-26 批次 68 的现场：6 条拖满 900s 预算，artifact 里 generating=true（「停止生成」
  // 在页面上）、answer card 数=0（答案卡片从未出现，而 question card=1 说明提问确实送出去了）、
  // login/captcha/accessRestricted 全 false。即前端已进入流式接收态，服务端一个 token 都不推。
  // 这种会话等多久都不会出内容，硬等只是白占槽位（6 条 ≈ 78 分钟）。
  const window = constantValue("ANSWER_FIRST_TOKEN_MS_DEFAULT");
  assert.ok(window > 0, "零字容忍窗必须是正的");
  assert.ok(
    window < 900_000,
    "零字容忍窗必须显著小于 900s 预算，否则「提前退出」不可能先于超时到达，等于没做",
  );
  assert.match(
    source,
    /return intEnvValue\("ONEGL_ANSWER_FIRST_TOKEN_MS", ANSWER_FIRST_TOKEN_MS_DEFAULT, 30_000\);/,
    "零字容忍窗要可配置，并且带 30s 下限 —— 低于它会把「平台正在排队/预热」误判成吞请求",
  );
  // 判据只认「从未出现过答案」：出过一个字就永久关闭这条路径。这是整个改动里唯一可能造成
  // 不可逆损失的地方 —— 一次页面重渲染导致的 0 采样不该把一条慢任务判死。
  const windowMs = 120_000;
  assert.equal(isSilentlyDropped({ answerLength: 0, firstTokenSeen: false, waitedMs: windowMs, windowMs }), true);
  assert.equal(isSilentlyDropped({ answerLength: 0, firstTokenSeen: false, waitedMs: windowMs - 1, windowMs }), false);
  assert.equal(isSilentlyDropped({ answerLength: 12, firstTokenSeen: false, waitedMs: 900_000, windowMs }), false);
  assert.equal(isSilentlyDropped({ answerLength: 0, firstTokenSeen: true, waitedMs: 900_000, windowMs }), false);
});

test("only an answer that has actually been written counts as settled", () => {
  // 收尾特征用来把「已写完」的确认窗从 150s 缩到 75s。判错的代价是一条被截断的数据，而截断
  // 不可逆（提问已提交，重试会重复提问），所以这个判定的正反两面都要钉住。
  //
  // 这段前缀必须越过 ANSWER_SETTLED_MIN_CHARS(120)：门槛本身也是判据的一部分，用一段 60 字的
  // 前缀会把「太短不认」这条规则无意中测成「收尾不认」，两边都过不了而看不出原因。
  const long =
    "绍兴越城区推拿理疗资源丰富，从三甲医院的专家手法到社区卫生服务中心的便捷服务，再到专业的养生调理馆，"
    + "选择很多。根据你的需求，我为你整理了以下几类口碑较好的推拿去处：公立医院适合做医疗调理，连锁门店适合日常放松，"
    + "你可以根据自己的情况来选。";

  // 正面：反问句收尾 —— 实测 10 条成功记录里 6 条如此
  assert.equal(looksSettled(`${long}你更倾向于去正规诊所看毛病，还是去推拿店放松一下？`), true);
  assert.equal(looksSettled(`${long}你想先了解哪一家的具体价位或者预约方式吗？`), true);
  assert.equal(looksSettled(`${long}在上述几家中选择一家去体验一下。`), true);

  // 负面：末尾没有收尾特征 —— 说明还在写，必须继续等
  assert.equal(looksSettled(`${long}核心优势：正规、专业，不用担心资质`), false);
  assert.equal(looksSettled(`${long}力度可调，无论是旅途劳累还是长期伏案`), false);

  // 负面：太短 —— 刚开头就带问号的片段不能被当成完整答案
  assert.equal(looksSettled("绍兴推拿哪家好？"), false);
  assert.equal(looksSettled(""), false);
  assert.equal(looksSettled(null), false);

  // 负面：问号在**中间**不算收尾。列表与小标题里问号很常见，拿全文判断会把「还在写」
  // 误判成「已写完」，这正是把检查范围限制在末尾 24 字符的原因。
  assert.equal(looksSettled(`${long}常见问题：颈椎病怎么调理？下面分三类说明，先说第一类`), false);

  // 末尾空白不该影响判定：扫描出来的文本常带换行
  assert.equal(looksSettled(`${long}还是去推拿店放松一下？\n\n  `), true);
});
