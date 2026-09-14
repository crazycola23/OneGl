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
      `WITH batch_runs AS (
         SELECT id, network_evidence_state, search_query_count
           FROM runs
          WHERE sampling_batch_id = $1
       ), retrieval AS (
         SELECT rs.*
           FROM retrieved_sources rs
           JOIN batch_runs br ON br.id = rs.run_id
       )
       SELECT
         (SELECT count(*) FROM batch_runs WHERE network_evidence_state = 'found') AS runs_with_network_evidence,
         (SELECT COALESCE(sum(search_query_count), 0) FROM batch_runs) AS search_queries,
         (SELECT count(*) FROM retrieval) AS retrieved_sources,
         (SELECT count(*) FROM retrieval
           WHERE match_method = 'canonical_url_exact') AS exact_citation_matches,
         (SELECT count(*) FROM retrieval
           WHERE visible_citation_id IS NOT NULL
             AND match_method IS DISTINCT FROM 'canonical_url_exact') AS alias_citation_matches,
         (SELECT count(*) FROM retrieval
           WHERE visible_citation_id IS NOT NULL) AS matched_citation_sources,
         (SELECT count(DISTINCT article_id) FROM retrieval) AS unique_retrieved_articles,
         (SELECT count(DISTINCT article_id) FROM retrieval
           WHERE visible_citation_id IS NOT NULL) AS unique_matched_articles`,
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
              (SELECT count(*)
                 FROM retrieved_sources rs
                WHERE rs.run_id = r.id AND rs.visible_citation_id IS NOT NULL) AS cited_candidates,
              (SELECT array_agg(q.query_text ORDER BY q.query_position)
                 FROM run_search_queries q
                WHERE q.run_id = r.id) AS queries
         FROM runs r
         JOIN prompts p ON p.id = r.prompt_id
        WHERE r.sampling_batch_id = $1
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

  const total = Number(s.retrieved_sources ?? 0);
  const exact = Number(s.exact_citation_matches ?? 0);
  const alias = Number(s.alias_citation_matches ?? 0);
  const matched = Number(s.matched_citation_sources ?? 0);
  const unmatched = Math.max(0, total - matched);

  console.log(`\n=== Retrieval -> Citation / Batch ${batchId} ===`);
  console.table([
    {
      有网络证据的运行: Number(s.runs_with_network_evidence ?? 0),
      搜索词: Number(s.search_queries ?? 0),
      候选来源: total,
      精确命中: exact,
      精确转化率: pct(exact, total),
      别名命中: alias,
      含别名命中: matched,
      含别名转化率: pct(matched, total),
      未匹配: unmatched,
      未匹配占比: pct(unmatched, total),
      唯一候选文章: Number(s.unique_retrieved_articles ?? 0),
      唯一命中文章: Number(s.unique_matched_articles ?? 0),
    },
  ]);

  // A conversion rate is only interpretable next to how much of the retrieval layer was
  // actually observed. If the network collector missed most of the candidates, the
  // survivors look proportionally better than they are, so say so before the number is
  // read as a finding.
  const unmatchedShare = total ? unmatched / total : null;
  if (unmatchedShare != null && unmatchedShare >= 0.5) {
    console.log(
      `\n⚠ 未匹配占比 ${pct(unmatched, total)}：多数候选既不是精确命中也不是别名命中。` +
        "在把它读成「豆包没有引用」之前，先确认网络证据是否抓全了（network_evidence_state、body 超限/超时诊断）。",
    );
  }

  const methods = (
    await pool.query(
      `SELECT COALESCE(rs.match_method, 'unmatched') AS method, count(*) AS sources
         FROM retrieved_sources rs
         JOIN runs r ON r.id = rs.run_id
        WHERE r.sampling_batch_id = $1
        GROUP BY 1
        ORDER BY sources DESC, method`,
      [batchId],
    )
  ).rows;
  if (methods.length) {
    console.log("\n=== 命中方式分布 ===");
    console.table(
      methods.map((row) => ({
        命中方式: row.method,
        候选数: Number(row.sources),
        占比: pct(row.sources, s.retrieved_sources),
      })),
    );
  }

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
    "\n说明：命中只发生在一个 Run 内部，并且每条记录都标注了 match_method。" +
      "canonical_url_exact 是唯一的精确口径；site_rule_alias 等别名口径单独统计，" +
      "不使用标题、语义相似或 LLM 推断。",
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
