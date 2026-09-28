import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAnswerCompletion } from "../src/db/persist.js";

/**
 * `answer_completion` 的取值规范化。
 *
 * 这一列存在的原因：文心一言实测**答案块反复整块重写**，第一版用「长度连续 3 轮稳定」
 * 判完成，正好落在重写间隙，收下了 41 字符的平台收尾追问句当成答案。
 * 而 `answer_truncated`（标点启发式）对它判 `false` —— 那句话以句号结尾。
 *
 * 也就是说：**现有护栏里没有任何一条能抓住那次误收。** 这一列是唯一的新增信号，
 * 所以它的取值校验必须是**失败即丢值**而不是**抛错**。
 */

/**
 * 未知取值降级为 null，而不是抛错。
 *
 * 抛错的后果是整条 run 写不进去 —— 连同它已经抓到的答案与 27 条引用一起丢。
 * 为了一个观测标记丢掉整轮采集，代价与收益完全不成比例。
 */
test("未知取值降级为 null，而不是让整条 run 写不进去", () => {
  assert.equal(normalizeAnswerCompletion("follow-up-chips"), "follow-up-chips");
  assert.equal(normalizeAnswerCompletion("timeout"), "timeout");
  assert.equal(normalizeAnswerCompletion("length-stability-fallback"), "length-stability-fallback");
  assert.equal(normalizeAnswerCompletion("unknown"), "unknown");

  // 没上报就是没上报：null 与 'unknown' 必须在统计里分开
  // （前者是"没量到"，后者是"量到是这个值"）。
  assert.equal(normalizeAnswerCompletion(null), null);
  assert.equal(normalizeAnswerCompletion(undefined), null);
  assert.equal(normalizeAnswerCompletion(""), null);

  // 平台改版引入的新值 / driver 打错的值：丢值，不丢 run。
  assert.equal(normalizeAnswerCompletion("streaming-settled"), null);
  assert.equal(normalizeAnswerCompletion("follow up chips"), null);
  assert.equal(normalizeAnswerCompletion(123), null);
  assert.equal(normalizeAnswerCompletion({}), null);
});

/** 大小写与空白不该让一个合法值变成 null —— 那是静默丢数据。 */
test("合法值的大小写与首尾空白被规范化", () => {
  assert.equal(normalizeAnswerCompletion("  Follow-Up-Chips  "), "follow-up-chips");
  assert.equal(normalizeAnswerCompletion("TIMEOUT"), "timeout");
});

/**
 * 取值集合与 `migrations/0031` 的 CHECK 约束必须逐字一致。
 *
 * 不一致的后果很具体：约束比代码宽松时，写入的非法值会让**整条 INSERT 失败**
 * （抛 DatabasePersistError 之外的 PG 错误），采集结果丢失；约束比代码严格时，
 * 合法值被拒，同上。两边都靠"记得同步"，所以在这里钉住。
 */
test("取值集合与迁移 0031 的 CHECK 约束一致", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(
    new URL("../migrations/0031_answer_completion.sql", import.meta.url),
    "utf8",
  );
  for (const value of ["follow-up-chips", "length-stability-fallback", "timeout", "unknown"]) {
    assert.ok(sql.includes(`'${value}'`), `迁移里必须出现取值 ${value}`);
    assert.equal(normalizeAnswerCompletion(value), value);
  }
  // 约束允许 NULL，而 normalizer 对未上报返回 null —— 两边一致。
  assert.match(sql, /answer_completion IS NULL/);
});
