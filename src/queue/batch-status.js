/**
 * 批次终态判定。
 *
 * 这是纯逻辑，不碰数据库、不碰 Redis，因此可以用 node --test 离线验证。
 *
 * 计数语义（三者之和在任何时刻都不超过 requested_jobs）：
 *   requested_jobs  本批次一共要执行的分配数
 *   completed_jobs  真正产出数据的 Run（success / partial）
 *   failed_jobs     失败 Run
 *   skipped_jobs    没有产出 Run 的分配（人工阻塞、批次被中止、账号不可用等）
 *
 * 关键规则：没有产出任何真实数据的批次绝不能是 completed。
 * 例如 requested=100 / completed=0 / failed=0 / skipped=100 只能是 partial——
 * 称它为 completed 会让「100 个关键词都跑完了」这个结论完全失真。
 */

export function resolveBatchOutcome({ requested, completed, failed, skipped }) {
  const req = Math.max(0, Number(requested) || 0);
  const done = Math.max(0, Number(completed) || 0);
  const bad = Math.max(0, Number(failed) || 0);
  const rawSkipped = Math.max(0, Number(skipped) || 0);

  const produced = done + bad;
  const outstanding = Math.max(0, req - produced);

  // 所有分配都已有结论：要么产出了 Run，要么被明确记为未执行。
  const settled = req > 0 && produced + rawSkipped >= req;

  // 终态时以「没有产出 Run 的分配数」为准，而不是累加计数，避免同一个分配
  // 既被记成 failed 又被记成 skipped 时把总数算超。
  const skippedCount = settled ? outstanding : Math.min(rawSkipped, outstanding);

  let status = null;
  if (settled) {
    if (done === 0) {
      // 一条真实数据都没产出：全部失败算 failed，全部未执行只能算 partial。
      status = bad > 0 ? "failed" : "partial";
    } else if (bad > 0 || skippedCount > 0) {
      status = "partial";
    } else {
      status = "completed";
    }
  }

  return { settled, status, skipped: skippedCount, produced, outstanding };
}

/**
 * 失败数解析：runs 表统计不到的那部分，必须从队列侧补上。
 *
 * 任务可能死在 RunStore.createRun 之前（领取任务之后的节流 / 连接阶段），此时 runs 表里
 * 连一行都没有，只按表统计就会把它当成「还没有结论」：completed 和 failed 都不含它，
 * settled 永远为 false，批次停在 running 不再前进，而队列里其实早就没有活任务了。
 * 批次 68 卡住的就是这样 11 条 —— 队列 failed 集合里有它们，runs 表里没有。
 *
 * 只在账对不上时才需要补，正常路径下 runs 表已覆盖全部任务，队列查询可以整段跳过。
 */
export function resolveFailedCount({ requested, completed, dbFailed, orphanFailed = 0 }) {
  const req = Math.max(0, Number(requested) || 0);
  const done = Math.max(0, Number(completed) || 0);
  const bad = Math.max(0, Number(dbFailed) || 0);
  const orphan = Math.max(0, Number(orphanFailed) || 0);
  return done + bad < req ? bad + orphan : bad;
}
