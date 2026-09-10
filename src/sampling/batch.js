import { persistRun } from "../db/persist.js";
import { assignAccounts, selectPrompts } from "./sample.js";
import { generateSeed } from "./random.js";

/**
 * Sampling batches: one experiment = one batch.
 *
 * Creating a batch draws the prompts and records everything needed to reproduce the
 * draw (seed, pool version, pool size, method, the exact selection). Executing it later
 * replays that stored selection, so a batch is never re-drawn between the two steps.
 */

export async function loadPool(pool, projectId) {
  // 抽样只能来自当前项目自己的、已启用且未删除的关键词池。
  // 这里是项目隔离的唯一入口，任何跨项目抽样都会先在这里失败。
  const { rows } = await pool.query(
    `SELECT id, prompt, category, pool_version
       FROM prompts
      WHERE project_id = $1 AND enabled = true AND deleted_at IS NULL
      ORDER BY prompt`,
    [projectId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    text: row.prompt,
    category: row.category,
    poolVersion: row.pool_version,
  }));
}

export async function createSamplingBatch(
  pool,
  { projectName, name, size, method = "stratified", seed = null, accounts = [], repeats = 1 },
  { log = console.log } = {},
) {
  const projectResult = await pool.query("SELECT id, target_brand FROM projects WHERE name = $1", [
    projectName,
  ]);
  const project = projectResult.rows[0];
  if (!project) throw new Error(`未找到项目「${projectName}」`);

  const poolPrompts = await loadPool(pool, project.id);
  if (!poolPrompts.length) {
    throw new Error(
      `项目「${projectName}」的关键词池为空，请先执行 npm run project:init 导入关键词池。`,
    );
  }

  const effectiveSeed = seed ?? generateSeed();
  const selected = selectPrompts({
    prompts: poolPrompts,
    size,
    method,
    seed: effectiveSeed,
  });

  if (!selected.length) throw new Error("抽样结果为空，请检查关键词池与抽样数量");
  if (!accounts.length) throw new Error("至少需要一个账号用于分配提问");

  const assignments = assignAccounts({
    prompts: selected,
    accounts,
    repeats,
    seed: effectiveSeed,
  });

  // pool_version is a property of the pool contents, not of the draw
  const poolVersion = poolPrompts.find((prompt) => prompt.poolVersion)?.poolVersion ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchResult = await client.query(
      `INSERT INTO sampling_batches (
         project_id, name, provider, pool_version, pool_size, sample_size,
         sampling_method, sampling_seed, account_keys, repeats, status
       )
       VALUES ($1, $2, 'doubao', $3, $4, $5, $6, $7, $8::jsonb, $9, 'pending')
       RETURNING id`,
      [
        project.id,
        name,
        poolVersion,
        poolPrompts.length,
        selected.length,
        method,
        effectiveSeed,
        JSON.stringify(accounts),
        repeats,
      ],
    );
    const batchId = Number(batchResult.rows[0].id);

    for (const assignment of assignments) {
      // 关键词正文同时写入快照：以后关键词被改名、禁用或删除，历史批次显示的
      // 仍然是当时真正抽中的那句话。
      await client.query(
        `INSERT INTO sampling_batch_prompts
           (batch_id, prompt_id, prompt_text, prompt_md5, category, selection_index, account_key)
         VALUES ($1, $2, $3, md5($3), $4, $5, $6)`,
        [
          batchId,
          assignment.prompt.id,
          assignment.prompt.text,
          assignment.prompt.category,
          assignment.selectionIndex,
          assignment.accountKey,
        ],
      );
    }

    await client.query("COMMIT");

    const byCategory = new Map();
    for (const assignment of assignments) {
      byCategory.set(assignment.prompt.category, (byCategory.get(assignment.prompt.category) ?? 0) + 1);
    }

    log(`已创建抽样批次 #${batchId}：${name}`);
    log(
      `  种子=${effectiveSeed} 方式=${method === "stratified" ? "分层" : "纯随机"} ` +
        `池=${poolPrompts.length} 抽样=${selected.length} 分配=${assignments.length}`,
    );
    log(
      `  分类分布：${[...byCategory.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => `${category}=${count}`)
        .join("，")}`,
    );

    return {
      batchId,
      seed: effectiveSeed,
      poolSize: poolPrompts.length,
      sampleSize: selected.length,
      assignments: assignments.length,
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadBatch(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT b.*, p.name AS project_name, p.target_brand
       FROM sampling_batches b
       JOIN projects p ON p.id = b.project_id
      WHERE b.id = $1`,
    [batchId],
  );
  const batch = rows[0];
  if (!batch) throw new Error(`未找到抽样批次 ${batchId}`);
  return batch;
}

export async function loadBatchAssignments(pool, batchId) {
  const { rows } = await pool.query(
    // 优先读批次内快照，快照缺失时才回退到关键词池
    `SELECT sbp.selection_index, sbp.category, sbp.account_key,
            p.id AS prompt_id, COALESCE(sbp.prompt_text, p.prompt) AS prompt
       FROM sampling_batch_prompts sbp
       LEFT JOIN prompts p ON p.id = sbp.prompt_id
      WHERE sbp.batch_id = $1
      ORDER BY sbp.selection_index`,
    [batchId],
  );
  return rows.map((row) => ({
    selectionIndex: Number(row.selection_index),
    category: row.category,
    accountKey: row.account_key,
    promptId: Number(row.prompt_id),
    prompt: row.prompt,
  }));
}

export async function markBatchStatus(pool, batchId, status, { touchStart = false, touchEnd = false } = {}) {
  const sets = ["status = $2"];
  if (touchStart) sets.push("started_at = COALESCE(started_at, now())");
  if (touchEnd) sets.push("finished_at = now()");
  await pool.query(
    `UPDATE sampling_batches SET ${sets.join(", ")} WHERE id = $1`,
    [batchId, status],
  );
}

/** Convenience for the CLI: persist a captured run against a batch assignment. */
export async function persistAssignmentRun(pool, { run, assignment, projectName, artifactPath }) {
  return persistRun({
    pool,
    run,
    project: projectName,
    artifactPath,
    accountKey: assignment.accountKey,
    samplingBatchId: run.samplingBatchId,
  });
}
