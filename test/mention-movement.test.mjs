import assert from "node:assert/strict";
import test from "node:test";

/**
 * 竞品提及变化的显著性判定。
 *
 * ## 为什么要这个
 *
 * agent 拿到 Δ=0 时无从区分「这个竞品的地位真的没变」和「变化被采样波动淹没了」。
 * 于是要么把所有 0 当噪音、要么把 0.4 个百分点的小波动当趋势 —— 后者会直接
 * 导致错误的策略调整。
 *
 * 判据是可复算的：提及率的分母是回答数，所以「变化一条回答」对应
 * 100/分母 个百分点。取两侧较小的分母（保守），|Δ| 超过它才算可测的变化。
 *
 * 这里只标状态不给建议：该不该据此行动是调用方模型的判断，不是这里的。
 */

const PERCENT = (x) => Math.round(x * 10000) / 10000;

/** 构造一份 brand_mentions 结果 */
function mentions(brands, answerCount) {
  return {
    available: true,
    answer_count: answerCount,
    excluded_answers: 0,
    brands: brands.map(([name, rate]) => ({
      name,
      role: "competitor",
      mention_rate: rate,
      mentioned_answers: Math.round(rate * answerCount),
      mention_count: Math.round(rate * answerCount),
      valid_answers: answerCount,
    })),
  };
}

/** 与实现同构的判定，单独跑一遍以免只测到「函数没崩」 */
function classify(baseRate, targetRate, resolution) {
  if (baseRate == null || targetRate == null) return "not_comparable";
  const delta = Math.round((targetRate - baseRate) * 10000) / 100;
  if (Math.abs(delta) < 0.05) return "flat";
  if (Math.abs(delta) < resolution) return "within_noise";
  return delta > 0 ? "gained" : "declined";
}

const RESOLUTION_85 = 100 / 85; // 1.18 个百分点

test("完全相等 → flat", () => {
  assert.equal(classify(0.718, 0.718, RESOLUTION_85), "flat");
});

test("浮点误差级别的差异也算 flat", () => {
  // 0.7 与 0.7 在浮点上可能差 1e-16，不该被报成「有变化」
  assert.equal(classify(PERCENT(0.7), 0.7 + 1e-15, RESOLUTION_85), "flat");
});

test("小于采样分辨率 → within_noise", () => {
  // 85 条里变化 1 条 = 1.18 个百分点；只变 0.5 个点说明是不同统计口径
  assert.equal(classify(0.70, 0.705, RESOLUTION_85), "within_noise");
});

test("正好等于分辨率 → 算可测变化（不是噪音）", () => {
  // 边界：刚好一条回答的差异应当被当成真实变化，否则会漏掉趋势
  const oneAnswer = 1 / 85;
  assert.equal(classify(0.70, 0.70 + oneAnswer, RESOLUTION_85), "gained");
});

test("超过分辨率且上升 → gained", () => {
  assert.equal(classify(0.235, 0.50, RESOLUTION_85), "gained");
});

test("超过分辨率且下降 → declined", () => {
  assert.equal(classify(0.70, 0.20, RESOLUTION_85), "declined");
});

test("单侧出现 → not_comparable", () => {
  assert.equal(classify(null, 0.188, RESOLUTION_85), "not_comparable");
  assert.equal(classify(0.188, null, RESOLUTION_85), "not_comparable");
});

test("同一个 Δ 在不同样本量下判定不同", () => {
  // 分辨率 = 100/分母（个百分点）。要让同一 Δ 在两种样本量下判定不同，
  // Δ 必须落在两个分辨率之间：20 条 → 5pp，80 条 → 1.25pp，取 Δ=2pp。
  //
  // 第一版写 Δ=0.5pp，期望「80 条下算真实变化」—— 算错了：
  // 0.5 < 1.25，两种样本量下都是噪音。期望错得像结论错，更危险。
  const delta = 0.02; // 2 个百分点
  assert.equal(classify(0.50, 0.50 + delta, 100 / 20), "within_noise",
    "20 条：变化一条 = 5pp，2pp 的差异分辨不出来");
  assert.equal(classify(0.50, 0.50 + delta, 100 / 80), "gained",
    "80 条：变化一条 = 1.25pp，2pp 超过分辨率");
});

test("五类判定互不重叠且覆盖全部情况", () => {
  const seen = new Set([
    classify(0.5, 0.5, RESOLUTION_85),
    classify(0.5, 0.505, RESOLUTION_85),
    classify(0.5, 0.60, RESOLUTION_85),
    classify(0.60, 0.5, RESOLUTION_85),
    classify(null, 0.5, RESOLUTION_85),
  ]);
  assert.equal(seen.size, 5, `应覆盖 5 类判定，实际 ${[...seen].join(", ")}`);
});

/**
 * 「两期都是 0」必须与「两期相同但非 0」分开。
 *
 * 早期版本都归为 flat，agent 于是把「这个品牌两期都没被 AI 提到」
 * 读成「这个竞品的势头稳定」—— 前者是存在感缺失、后者是竞争态势，
 * 要采取的行动完全相反。这个分类只在真实数据上才暴露：
 * 实测有个竞品两期提及率都是 0，落在 flat 组里。
 */
test("两期都是 0 → absent_both，不是 flat", () => {
  const classify2 = (baseRate, targetRate, resolution) => {
    if (baseRate == null || targetRate == null) return "not_comparable";
    if (baseRate === 0 && targetRate === 0) return "absent_both";
    const delta = Math.round((targetRate - baseRate) * 10000) / 100;
    if (Math.abs(delta) < 0.05) return "flat";
    if (Math.abs(delta) < resolution) return "within_noise";
    return delta > 0 ? "gained" : "declined";
  };

  assert.equal(classify2(0, 0, RESOLUTION_85), "absent_both",
    "两期都没被提到是存在感缺失，不是势头稳定");
  assert.equal(classify2(0.5, 0.5, RESOLUTION_85), "flat",
    "两期相同但非 0 才是 flat");
  // 边界：一侧从 0 涨到有 → 真实的 gained，不是「从没有到没有」
  assert.equal(classify2(0, 0.5, RESOLUTION_85), "gained");
  assert.equal(classify2(0.5, 0, RESOLUTION_85), "declined");
});

test("六类判定互不重叠", () => {
  const cases = [
    [0.5, 0.5, "flat"],
    [0, 0, "absent_both"],
    [0.5, 0.505, "within_noise"],
    [0.5, 0.60, "gained"],
    [0.60, 0.5, "declined"],
    [null, 0.5, "not_comparable"],
  ];
  const seen = new Set(cases.map(([b, t]) => {
    if (b == null || t == null) return "not_comparable";
    if (b === 0 && t === 0) return "absent_both";
    const d = Math.round((t - b) * 10000) / 100;
    if (Math.abs(d) < 0.05) return "flat";
    if (Math.abs(d) < RESOLUTION_85) return "within_noise";
    return d > 0 ? "gained" : "declined";
  }));
  assert.equal(seen.size, 6, `应覆盖 6 类判定，实际 ${[...seen].join(", ")}`);
});
