import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { createPool } from "../src/db/pool.js";
import { buildBatchReport } from "../src/db/report.js";

/**
 * 导出一个抽样批次的完整数据快照，供生成客户交付用的 HTML 报告使用。
 * 用法：node tools/export-batch.js <batchId> <输出文件>
 */
const batchId = Number(process.argv[2] ?? 1);
const outFile = process.argv[3] ?? `batch-${batchId}.json`;

const pool = createPool();
try {
  const report = await buildBatchReport(pool, batchId);

  const runs = (
    await pool.query(
      `SELECT r.id,
              r.local_run_id,
              r.status,
              r.account_key,
              r.brand_mentioned,
              r.mention_count,
              r.matched_terms,
              r.expected_citation_count,
              r.captured_citation_count,
              r.conversation_reset_confirmed,
              r.error_code,
              r.started_at,
              r.finished_at,
              p.prompt,
              p.category,
              a.selection_index,
              length(r.answer) AS answer_length,
              left(r.answer, 900) AS answer_excerpt
         FROM runs r
         JOIN prompts p ON p.id = r.prompt_id
         LEFT JOIN (
           SELECT batch_id, prompt_id, account_key, min(selection_index) AS selection_index
             FROM sampling_batch_prompts
            GROUP BY batch_id, prompt_id, account_key
         ) a
                ON a.batch_id = r.sampling_batch_id
               AND a.prompt_id = r.prompt_id
               AND a.account_key IS NOT DISTINCT FROM r.account_key
        WHERE r.sampling_batch_id = $1
        ORDER BY a.selection_index NULLS LAST, r.id`,
      [batchId],
    )
  ).rows;

  const citations = (
    await pool.query(
      `SELECT r.id AS run_id,
              a.canonical_url,
              a.title,
              a.normalized_domain AS domain,
              a.first_seen_at,
              c.citation_marker,
              c.source_position
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
        WHERE r.sampling_batch_id = $1
        ORDER BY r.id, c.source_position NULLS LAST`,
      [batchId],
    )
  ).rows;

  const domains = (
    await pool.query(
      `SELECT a.normalized_domain AS domain,
              count(*) AS citations,
              count(DISTINCT a.id) AS articles,
              count(DISTINCT c.run_id) AS runs
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
        WHERE r.sampling_batch_id = $1
        GROUP BY 1
        ORDER BY citations DESC, domain`,
      [batchId],
    )
  ).rows;

  await writeFile(
    outFile,
    JSON.stringify({ report, runs, citations, domains }, null, 2),
    "utf8",
  );
  console.log(`已导出 ${outFile}`);
  console.log(
    `runs=${runs.length} citations=${citations.length} domains=${domains.length}`,
  );
} finally {
  await pool.end();
}
