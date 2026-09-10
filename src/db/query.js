import "dotenv/config";
import { createPool } from "./pool.js";

/**
 * 只读查询命令，用于在终端核对入库结果。
 *
 *   npm run db:query -- overview
 *   npm run db:query -- run <local_run_id>
 *   npm run db:query -- prompt "<prompt 文本>"
 *   npm run db:query -- article <canonical_url>
 *   npm run db:query -- domains [数量]
 *   npm run db:query -- dedup
 *   npm run db:query -- batch <批次ID>
 *   npm run db:query -- batch-prompts <批次ID>
 *   npm run db:query -- compare-batches <批次A> <批次B>
 */

const pool = createPool();

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function overview() {
  const [row] = await query(`
    SELECT
      (SELECT count(*) FROM projects)          AS 项目,
      (SELECT count(*) FROM prompts)           AS 关键词,
      (SELECT count(*) FROM sampling_batches)  AS 批次,
      (SELECT count(*) FROM runs)              AS 运行,
      (SELECT count(*) FROM articles)          AS 文章,
      (SELECT count(*) FROM citations)         AS 引用,
      (SELECT count(*) FROM accounts)          AS 账号
  `);
  section("总览");
  console.table([row]);
}

async function runDetail(identifier) {
  const [run] = await query(
    `SELECT r.id, r.local_run_id, r.provider, r.status, r.started_at, r.finished_at,
            r.expected_citation_count, r.captured_citation_count, r.citation_state,
            r.conversation_reset_confirmed, r.brand_mentioned, r.mention_count,
            r.sampling_batch_id, r.account_key, r.error_code,
            p.prompt, p.external_id, pr.name AS project
       FROM runs r
       JOIN prompts p   ON p.id = r.prompt_id
       JOIN projects pr ON pr.id = p.project_id
      WHERE r.local_run_id = $1 OR r.id::text = $1`,
    [identifier],
  );

  if (!run) {
    console.log(`未找到运行：${identifier}`);
    return;
  }

  section(`运行 ${run.local_run_id}`);
  console.table([
    {
      数据库ID: run.id,
      项目: run.project,
      批次: run.sampling_batch_id ?? "—",
      账号: run.account_key ?? "—",
      状态: run.status,
      服务方: run.provider,
      开始时间: run.started_at,
      结束时间: run.finished_at,
      新会话已确认: run.conversation_reset_confirmed,
      品牌已提及: run.brand_mentioned,
      提及次数: run.mention_count,
      引用数: `${run.captured_citation_count} / ${run.expected_citation_count ?? "—"}`,
      引用状态: run.citation_state,
      错误: run.error_code ?? "—",
    },
  ]);
  console.log("提问：", run.prompt);
  console.log(
    "回答：",
    `${(run.answer || "").slice(0, 400)}${(run.answer || "").length > 400 ? "…" : ""}`,
  );

  const citations = await query(
    `SELECT c.source_position AS 序号, a.normalized_domain AS 域名, a.domain AS 主机名,
            c.relation_status AS 关联状态, c.citation_marker AS 标注, a.title AS 标题,
            (c.tracked_article_id IS NOT NULL) AS 是否监控文章
       FROM citations c
       JOIN articles a ON a.id = c.article_id
      WHERE c.run_id = $1
      ORDER BY c.source_position`,
    [run.id],
  );
  section(`可见引用（${citations.length}）`);
  console.table(citations);
}

async function promptRuns(promptText) {
  const rows = await query(
    `SELECT r.id AS 数据库ID, r.local_run_id AS 运行ID, r.status AS 状态,
            r.expected_citation_count AS 页面标注, r.captured_citation_count AS 实际抓取,
            r.brand_mentioned AS 品牌已提及, r.conversation_reset_confirmed AS 新会话已确认,
            r.account_key AS 账号, r.started_at AS 开始时间, r.error_code AS 错误
       FROM runs r
       JOIN prompts p ON p.id = r.prompt_id
      WHERE p.prompt = $1
      ORDER BY r.started_at DESC`,
    [promptText],
  );
  section(`该 Prompt 的运行历史（${rows.length}）`);
  console.table(rows);
}

async function articleDetail(canonicalUrl) {
  const [article] = await query(`SELECT * FROM articles WHERE canonical_url = $1`, [canonicalUrl]);
  if (!article) {
    console.log(`未找到文章：${canonicalUrl}`);
    return;
  }

  const [stats] = await query(
    `SELECT count(*) AS citation_count, count(DISTINCT run_id) AS run_count,
            min(created_at) AS first_cited_at, max(created_at) AS last_cited_at
       FROM citations WHERE article_id = $1`,
    [article.id],
  );

  section("文章");
  console.table([
    {
      ID: article.id,
      主机名: article.domain,
      归一化域名: article.normalized_domain,
      标题: article.title,
      首次发现: article.first_seen_at,
      最近发现: article.last_seen_at,
      被引用次数: stats.citation_count,
      涉及运行数: stats.run_count,
      首次被引用: stats.first_cited_at,
      最近被引用: stats.last_cited_at,
    },
  ]);

  const prompts = await query(
    `SELECT DISTINCT pr.name AS 项目, p.external_id AS 问题编号, p.prompt AS 问题,
            r.local_run_id AS 运行ID, c.source_position AS 引用位次
       FROM citations c
       JOIN runs r     ON r.id = c.run_id
       JOIN prompts p  ON p.id = r.prompt_id
       JOIN projects pr ON pr.id = p.project_id
      WHERE c.article_id = $1
      ORDER BY r.local_run_id`,
    [article.id],
  );
  section(`被以下提问引用（${prompts.length}）`);
  console.table(prompts);
}

async function domains(limit) {
  const rows = await query(
    `SELECT a.normalized_domain AS 域名,
            count(*)                  AS 引用数,
            count(DISTINCT a.id)      AS 文章数,
            count(DISTINCT c.run_id)  AS 运行数
       FROM citations c
       JOIN articles a ON a.id = c.article_id
      GROUP BY 1
      ORDER BY 引用数 DESC, 域名 ASC
      LIMIT $1`,
    [limit],
  );
  section(`域名聚合（前 ${rows.length}）`);
  console.table(rows);
}

async function dedup() {
  const rows = await query(
    `SELECT a.canonical_url            AS 链接,
            a.normalized_domain        AS 域名,
            count(*)                   AS 引用数,
            count(DISTINCT c.run_id)   AS 运行数,
            count(DISTINCT p.id)       AS 涉及问题数,
            count(DISTINCT a.id)       AS 文章行数
       FROM articles a
       JOIN citations c ON c.article_id = a.id
       JOIN runs r      ON r.id = c.run_id
       JOIN prompts p   ON p.id = r.prompt_id
      GROUP BY a.id
     HAVING count(DISTINCT p.id) > 1
      ORDER BY 引用数 DESC
      LIMIT 25`,
    [],
  );
  section(`被多个不同提问引用的文章（${rows.length}）`);
  console.table(rows);
  if (!rows.length) {
    console.log("目前还没有一篇文章被两个不同提问引用过。");
  }
}

async function batchRuns(batchId) {
  const rows = await query(
    `SELECT sbp.selection_index AS 序号, sbp.category AS 分类, r.account_key AS 账号,
            r.status AS 状态, r.conversation_reset_confirmed AS 新会话已确认,
            r.brand_mentioned AS 品牌已提及, r.mention_count AS 提及次数,
            r.captured_citation_count AS 实际抓取, r.expected_citation_count AS 页面标注,
            r.error_code AS 错误, r.local_run_id AS 运行ID,
            left(COALESCE(r.answer, ''), 40) AS 回答开头
       FROM runs r
       JOIN sampling_batch_prompts sbp
         ON sbp.batch_id = r.sampling_batch_id
        AND sbp.prompt_id = r.prompt_id
        AND sbp.account_key IS NOT DISTINCT FROM r.account_key
      WHERE r.sampling_batch_id = $1
      ORDER BY sbp.selection_index, r.started_at`,
    [batchId],
  );
  section(`批次 ${batchId} 的运行（${rows.length}）`);
  console.table(rows);

  const detail = await query(
    `SELECT sbp.selection_index AS 序号, sbp.category AS 分类, r.error_code AS 错误,
            left(COALESCE(r.error_message, ''), 90) AS 错误详情, r.local_run_id AS 运行ID
       FROM runs r
       JOIN sampling_batch_prompts sbp
         ON sbp.batch_id = r.sampling_batch_id
        AND sbp.prompt_id = r.prompt_id
        AND sbp.account_key IS NOT DISTINCT FROM r.account_key
      WHERE r.sampling_batch_id = $1 AND r.error_code IS NOT NULL
      ORDER BY sbp.selection_index`,
    [batchId],
  );
  for (const row of detail) {
    console.log(`\n  #${row.序号} ${row.运行ID} ${row.错误}：${row.错误详情}`);
  }
}

async function batchPrompts(batchId) {
  const rows = await query(
    `SELECT sbp.selection_index AS 序号, sbp.category AS 分类, sbp.account_key AS 账号, p.prompt AS 提问
       FROM sampling_batch_prompts sbp
       JOIN prompts p ON p.id = sbp.prompt_id
      WHERE sbp.batch_id = $1
      ORDER BY sbp.selection_index`,
    [batchId],
  );
  section(`批次 ${batchId} 抽到的提问（${rows.length}）`);
  console.table(rows);
  return rows;
}

async function compareBatches([left, right]) {
  const a = await batchPrompts(Number(left));
  const b = await batchPrompts(Number(right));
  const key = (row) => `${row.序号}|${row.分类}|${row.提问}`;
  const same = a.length === b.length && a.every((row, index) => key(row) === key(b[index]));
  section(`抽样复现对比：批次 ${left} 与批次 ${right}`);
  console.log(same ? "两次抽样完全一致（可复现）" : "两次抽样不一致");
  if (!same) {
    console.table(a.map((row, index) => ({ 序号: row.序号, 批次A: row.提问, 批次B: b[index]?.提问 })));
  }
  return same;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    console.log(
      "用法：npm run db:query -- <overview|run|prompt|article|domains|dedup|batch|batch-prompts|compare-batches> [参数]",
    );
    return;
  }

  if (command === "overview") await overview();
  else if (command === "run") await runDetail(rest[0] ?? "");
  else if (command === "prompt") await promptRuns(rest.join(" "));
  else if (command === "article") await articleDetail(rest.join(" "));
  else if (command === "domains") await domains(Number(rest[0] ?? 20));
  else if (command === "dedup") await dedup();
  else if (command === "batch") await batchRuns(Number(rest[0] ?? 0));
  else if (command === "batch-prompts") await batchPrompts(Number(rest[0] ?? 0));
  else if (command === "compare-batches") await compareBatches(rest);
  else throw new Error(`未知查询命令：${command}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
