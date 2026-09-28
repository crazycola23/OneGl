import "dotenv/config";

import { pathToFileURL } from "node:url";

import { createPool, isDatabaseConfigured } from "../src/db/pool.js";
import { runIdFor } from "../src/queue/batches.js";
import { publicId } from "../src/tasks/service.js";

/**
 * 回填 SaaS 结果行：让「命令行创建的批次」也能通过 /v1 API 读到。
 *
 * ## 为什么需要它
 *
 * `service_task_results` 只在通过 API 启动 task execution 时写入
 * （见 src/tasks/service.js 的 ensureTaskExecutionForBatch）。
 * 用 CLI 直接建的批次不会产生 execution，也就没有任何 result 行 ——
 * 于是这批数据对整个 /v1 不可见：runs 表里有，问答和引用都齐，就是取不到。
 *
 * 本工具为这类批次补齐 task / execution / result 三层，让它们进入 API 契约。
 *
 * ## 幂等
 *
 * 全程 ON CONFLICT DO NOTHING，可反复执行：
 *   - service_tasks.project_id 有 UNIQUE，一个 project 只有一个 task
 *   - service_task_executions.batch_id 有 UNIQUE，一个批次只有一个 execution
 *   - service_task_results.execution_id + selection_index 有 UNIQUE
 * 已存在的行不会被覆盖，也不会因为重复运行产生第二份。
 *
 * ## 默认干跑
 *
 * 不加 --apply 时只打印将要写入什么，不落库。写操作必须显式确认。
 *
 * 用法：
 *   node tools/backfill-saas-results.mjs                    # 干跑，列出所有缺口
 *   node tools/backfill-saas-results.mjs --batch 68 --apply # 只回填指定批次并落库
 */

function parseArgs(argv) {
  const out = { apply: false, batches: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--batch") {
      const value = argv[i + 1];
      if (!value || !/^\d+$/.test(value)) throw new Error("--batch 需要一个批次 id，例如 --batch 68");
      out.batches.push(Number(value));
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }
  return out;
}

/**
 * 找出所有「有租户归属、有 run、但没有 result 行」的批次。
 *
 * 三个条件同时成立才算缺口：
 *   1. 批次所属 project 在 service_project_bindings 里（= 有租户）
 *   2. 批次跑出过 run（= 有实际数据可暴露）
 *   3. 该批次没有任何 service_task_results（= API 取不到）
 */
async function findGaps(db, { batches = [] } = {}) {
  const { rows } = await db.query(
    `SELECT b.id AS batch_id, b.name, b.provider, b.project_id, b.status AS batch_status,
            pb.tenant_id, pb.display_name,
            (SELECT t.id      FROM service_tasks t WHERE t.project_id = b.project_id) AS task_id,
            (SELECT t.public_id FROM service_tasks t WHERE t.project_id = b.project_id) AS task_public_id,
            (SELECT e.id      FROM service_task_executions e WHERE e.batch_id = b.id) AS execution_id,
            (SELECT count(*)::int FROM service_task_results sr WHERE sr.batch_id = b.id) AS existing_results,
            (SELECT count(*)::int FROM sampling_batch_prompts sbp WHERE sbp.batch_id = b.id) AS prompts,
            (SELECT count(*)::int FROM runs r WHERE r.sampling_batch_id = b.id) AS runs
       FROM sampling_batches b
       JOIN service_project_bindings pb ON pb.project_id = b.project_id
      WHERE ($1::bigint[] IS NULL OR b.id = ANY($1::bigint[]))
        AND EXISTS (SELECT 1 FROM runs r WHERE r.sampling_batch_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM service_task_results sr WHERE sr.batch_id = b.id)
      ORDER BY b.id DESC`,
    [batches.length ? batches : null],
  );
  return rows;
}

/**
 * 为一个缺口批次补齐三层记录。
 *
 * 关键点：run_id 必须用 runIdFor 推导，不能自己拼字符串。
 * 那是 CLI、worker、SaaS 三处共用的唯一算法（src/queue/batches.js），
 * 自己拼会与采集侧的实际 local_run_id 错位，结果行就会指向不存在的 run。
 */
async function backfillBatch(db, gap, { log = console.log } = {}) {
  const batchId = Number(gap.batch_id);

  // 1) task：project_id 唯一，一个 project 只会有一个 task
  let taskId = gap.task_id;
  let taskPublicId = gap.task_public_id;
  if (!taskId) {
    const name = gap.display_name || gap.name || `batch-${batchId}`;
    const { rows } = await db.query(
      `INSERT INTO service_tasks
         (public_id, tenant_id, project_id, name, platforms, account_ids,
          sampling_method, repeats, state)
       VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, 'stratified', 1, 'active')
       ON CONFLICT (project_id) DO NOTHING
       RETURNING id, public_id`,
      [publicId("tsk"), gap.tenant_id, gap.project_id, name, JSON.stringify([gap.provider])],
    );
    if (rows[0]) {
      taskId = rows[0].id;
      taskPublicId = rows[0].public_id;
    } else {
      // 并发下另一个进程刚插入了，回读它。
      const existing = await db.query(
        "SELECT id, public_id FROM service_tasks WHERE project_id = $1",
        [gap.project_id],
      );
      taskId = existing.rows[0]?.id ?? null;
      taskPublicId = existing.rows[0]?.public_id ?? null;
    }
    log(`  task      ${taskPublicId ? `#${taskId} ${taskPublicId}` : "创建失败"}`);
  } else {
    log(`  task      已存在 #${taskId} ${taskPublicId}`);
  }
  if (!taskId) throw new Error(`批次 ${batchId} 无法确定 service_tasks 行`);

  // 2) execution：batch_id 唯一
  let executionId = gap.execution_id;
  if (!executionId) {
    const { rows } = await db.query(
      `INSERT INTO service_task_executions
         (public_id, tenant_id, task_id, batch_id, trigger_type)
       VALUES ($1, $2, $3, $4, 'manual')
       ON CONFLICT (batch_id) DO NOTHING
       RETURNING id, public_id`,
      [publicId("exe"), gap.tenant_id, taskId, batchId],
    );
    if (rows[0]) {
      executionId = rows[0].id;
      log(`  execution ${rows[0].public_id}`);
    } else {
      const existing = await db.query(
        "SELECT id, public_id FROM service_task_executions WHERE batch_id = $1",
        [batchId],
      );
      executionId = existing.rows[0]?.id ?? null;
      log(`  execution 已存在 ${existing.rows[0]?.public_id ?? "(读取失败)"}`);
    }
  } else {
    log(`  execution 已存在 #${executionId}`);
  }
  if (!executionId) throw new Error(`批次 ${batchId} 无法确定 service_task_executions 行`);

  // 3) result：每条 sampling_batch_prompts 一行
  const { rows: assignments } = await db.query(
    `SELECT sbp.selection_index, sbp.prompt_id,
            COALESCE(sbp.prompt_text, p.prompt) AS question,
            p.external_id,
            (SELECT count(*)::int FROM runs r
              WHERE r.local_run_id = 'run_b' || sbp.batch_id || '_i' || sbp.selection_index) AS run_matches
       FROM sampling_batch_prompts sbp
       LEFT JOIN prompts p ON p.id = sbp.prompt_id
      WHERE sbp.batch_id = $1
      ORDER BY sbp.selection_index`,
    [batchId],
  );

  let inserted = 0;
  const claimed = new Set();
  for (const a of assignments) {
    // 同一 external_id 不能在一个 execution 里出现两次（DB 有唯一约束兜底，
    // 这里先归一，避免整批插入中途失败）。
    const externalId = a.external_id == null || claimed.has(a.external_id) ? null : a.external_id;
    claimed.add(a.external_id);

    const { rowCount } = await db.query(
      `INSERT INTO service_task_results
         (public_id, tenant_id, execution_id, batch_id, selection_index, prompt_id,
          question, platform, run_id, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (execution_id, selection_index) DO NOTHING`,
      [
        publicId("res"),
        gap.tenant_id,
        executionId,
        batchId,
        Number(a.selection_index),
        a.prompt_id,
        a.question,
        gap.provider,
        runIdFor(batchId, Number(a.selection_index)),
        externalId,
      ],
    );
    inserted += rowCount;
  }

  const missingRun = assignments.filter((a) => a.run_matches === 0).length;
  log(`  result    新增 ${inserted} 条（分配 ${assignments.length}，其中 ${missingRun} 条无对应 run）`);
  return { batchId, inserted, assignments: assignments.length, missingRun };
}

export async function backfillSaasResults(pool, { batches = [], apply = false, log = console.log } = {}) {
  const gaps = await findGaps(pool, { batches });
  if (!gaps.length) {
    log("没有需要回填的批次。");
    return { gaps: [], applied: [] };
  }

  log(`\n发现 ${gaps.length} 个缺口批次：\n`);
  console.table(
    gaps.map((g) => ({
      批次: g.batch_id,
      平台: g.provider,
      租户: g.tenant_id,
      project: g.project_id,
      问题数: g.prompts,
      运行数: g.runs,
      已有result: g.existing_results,
      task: g.task_public_id ?? "缺失",
    })),
  );

  if (!apply) {
    log("\n这是干跑。加 --apply 才会写入。");
    return { gaps, applied: [] };
  }

  log("");
  const applied = [];
  for (const gap of gaps) {
    log(`批次 ${gap.batch_id}：`);
    // 每个批次一个事务：某一批失败不影响其它批次，也不留下半截状态。
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 事务内重算缺口，防止两个进程同时回填同一批次。
      const fresh = (await findGaps(client, { batches: [Number(gap.batch_id)] }))[0];
      if (!fresh) {
        await client.query("ROLLBACK");
        log("  已被其他进程回填，跳过");
        continue;
      }
      const result = await backfillBatch(client, fresh, { log });
      await client.query("COMMIT");
      applied.push(result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      log(`  失败并回滚：${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  log(`\n完成：${applied.length} 个批次，共写入 ${applied.reduce((s, r) => s + r.inserted, 0)} 条 result。`);
  return { gaps, applied };
}

// 用 pathToFileURL 而不是 `file://${process.argv[1]}`：后者在 Windows 上
// 得到 file://D:\path\file.mjs（反斜杠 + 缺斜杠），与 import.meta.url 的
// file:///D:/path/file.mjs 永远不相等，于是整个 CLI 分支静默不执行、退出码 0。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL 未配置。");
    process.exitCode = 1;
  } else {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        [
          "用法：",
          "  node tools/backfill-saas-results.mjs                     干跑，列出缺口",
          "  node tools/backfill-saas-results.mjs --batch 68 --apply  回填指定批次",
          "",
          "为命令行创建的批次补齐 service_tasks / executions / results，使其可被 /v1 API 读取。",
        ].join("\n"),
      );
    } else {
      const pool = createPool();
      try {
        const { applied } = await backfillSaasResults(pool, { batches: args.batches, apply: args.apply });
        if (args.apply) {
          // 回填后立刻自检，让操作者不用再去查库确认。
          const { rows } = await pool.query(
            `SELECT sr.batch_id, count(*)::int n,
                    count(*) FILTER (WHERE r.id IS NOT NULL)::int with_run
               FROM service_task_results sr
               LEFT JOIN runs r ON r.local_run_id = sr.run_id
              ${args.batches.length ? "WHERE sr.batch_id = ANY($1::bigint[])" : ""}
              GROUP BY sr.batch_id ORDER BY sr.batch_id`,
            args.batches.length ? [args.batches] : [],
          );
          console.log("\n回填后校验：");
          console.table(rows);
          // 成功就是成功。写入 0 条不等于失败：目标批次可能早已由 API 正常创建，
          // 这时 findGaps 根本不会把它们列进来，applied 为空是预期结果。
          if (applied.length) {
            log(`\n已回填 ${applied.length} 个批次。重复执行本命令不会再写入新行。`);
          }
        }
      } catch (error) {
        console.error(`回填失败：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      } finally {
        await pool.end();
      }
    }
  }
}
