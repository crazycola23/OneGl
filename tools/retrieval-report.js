import "dotenv/config";
import { createPool } from "../src/db/pool.js";

const pool = createPool();

function pct(numerator, denominator) {
  if (!Number(denominator)) return "n/a";
  return `${((Number(numerator) / Number(denominator)) * 100).toFixed(1)}%`;
}

function parseBatchId(argv) {
  const index = argv.indexOf("--batch");
  const raw = index >= 0 ? argv[index + 1] : argv[0];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Usage: node tools/retrieval-report.js --batch <positive batch id>");
  }
  return value;
}

async function buildReport(batchId) {
  const [summary] = (
    await pool.query(
      `SELECT
         count(DISTINCT r.id) FILTER (WHERE r.network_evidence_state = 'found') AS runs_with_network_evidence,
         count(rs.id) AS retrieved_sources,
         count(rs.id) FILTER (WHERE rs.visible_citation_id IS NOT NULL) AS exact_citation_matches,
         count(DISTINCT rs.article_id) AS unique_retrieved_articles,
         count(DISTINCT rs.article_id) FILTER (WHERE rs.visible_citation_id IS NOT NULL) AS unique_matched_articles,
         COALESCE(sum(r.search_query_count), 0) AS search_queries
       FROM runs r
       LEFT JOIN retrieved_sources rs ON rs.run_id = r.id
      WHERE r.sampling_batch_id = $1`,
      [batchId],
    )
  ).rows;

  const domains = (
    await pool.query(
      `SELECT a.normalized_domain AS domain,
              count(*) AS retrieved,
              count(*) FILTER (WHERE rs.visible_citation_id IS NOT NULL) AS cited,
              count(DISTINCT rs.article_id) AS articles,
              count(DISTINCT rs.run_id) AS runs
         FROM retrieved_sources rs
         JOIN articles a ON a.id = rs.article_id
         JOIN runs r ON r.id = rs.run_id
        WHERE r.sampling_batch_id = $1
        GROUP BY a.normalized_domain
        ORDER BY retrieved DESC, cited DESC, domain
        LIMIT 30`,
      [batchId],
    )
  ).rows;

  const runs = (
    await pool.query(
      `SELECT r.local_run_id,
              p.prompt,
              r.network_evidence_state,
              r.search_query_count,
              r.retrieved_source_count,
              count(rs.id) FILTER (WHERE rs.visible_citation_id IS NOT NULL) AS cited_candidates,
              array_agg(q.query_text ORDER BY q.query_position)
                FILTER (WHERE q.id IS NOT NULL) AS queries
         FROM runs r
         JOIN prompts p ON p.id = r.prompt_id
         LEFT JOIN retrieved_sources rs ON rs.run_id = r.id
         LEFT JOIN run_search_queries q ON q.run_id = r.id
        WHERE r.sampling_batch_id = $1
        GROUP BY r.id, p.prompt
        ORDER BY r.started_at`,
      [batchId],
    )
  ).rows;

  return { summary, domains, runs };
}

async function main() {
  const batchId = parseBatchId(process.argv.slice(2));
  const report = await buildReport(batchId);
  const s = report.summary;

  console.log(`\n=== Retrieval -> Citation / Batch ${batchId} ===`);
  console.table([
    {
      有网络证据的运行: Number(s.runs_with_network_evidence ?? 0),
      搜索词: Number(s.search_queries ?? 0),
      候选来源: Number(s.retrieved_sources ?? 0),
      精确命中最终引用: Number(s.exact_citation_matches ?? 0),
      候选转化率: pct(s.exact_citation_matches, s.retrieved_sources),
      唯一候选文章: Number(s.unique_retrieved_articles ?? 0),
      唯一命中文章: Number(s.unique_matched_articles ?? 0),
    },
  ]);

  if (report.domains.length) {
    console.log("\n=== 按域名的候选采用率 ===");
    console.table(
      report.domains.map((row) => ({
        域名: row.domain,
        候选次数: Number(row.retrieved),
        最终引用: Number(row.cited),
        转化率: pct(row.cited, row.retrieved),
        候选文章数: Number(row.articles),
        涉及运行数: Number(row.runs),
      })),
    );
  }

  if (report.runs.length) {
    console.log("\n=== 每个 Run ===");
    console.table(
      report.runs.map((row) => ({
        运行ID: row.local_run_id,
        网络证据: row.network_evidence_state ?? "—",
        搜索词数: Number(row.search_query_count ?? 0),
        候选数: Number(row.retrieved_source_count ?? 0),
        最终命中: Number(row.cited_candidates ?? 0),
        转化率: pct(row.cited_candidates, row.retrieved_source_count),
        搜索词: Array.isArray(row.queries) ? [...new Set(row.queries)].join(" | ").slice(0, 100) : "",
        问题: String(row.prompt ?? "").slice(0, 80),
      })),
    );
  }

  console.log(
    "\n说明：最终命中只采用同一 Run 内 canonical URL 完全相等（canonical_url_exact），不使用标题或语义相似推断。",
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
