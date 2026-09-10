import "dotenv/config";
import { createPool } from "./pool.js";

/**
 * Minimal read-only queries over the persisted citation data.
 *
 *   npm run db:query -- overview
 *   npm run db:query -- run <local_run_id>
 *   npm run db:query -- prompt "<prompt text>"
 *   npm run db:query -- article <canonical_url>
 *   npm run db:query -- domains [limit]
 *   npm run db:query -- dedup
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
      (SELECT count(*) FROM projects)  AS projects,
      (SELECT count(*) FROM prompts)   AS prompts,
      (SELECT count(*) FROM runs)      AS runs,
      (SELECT count(*) FROM articles)  AS articles,
      (SELECT count(*) FROM citations) AS citations
  `);
  section("Overview");
  console.table([row]);
}

async function runDetail(identifier) {
  const [run] = await query(
    `SELECT r.id, r.local_run_id, r.provider, r.status, r.started_at, r.finished_at,
            r.expected_citation_count, r.captured_citation_count, r.citation_state,
            r.error_code, r.answer, p.prompt, p.external_id, pr.name AS project
       FROM runs r
       JOIN prompts p  ON p.id = r.prompt_id
       JOIN projects pr ON pr.id = p.project_id
      WHERE r.local_run_id = $1 OR r.id::text = $1`,
    [identifier],
  );

  if (!run) {
    console.log(`run not found: ${identifier}`);
    return;
  }

  section(`Run ${run.local_run_id}`);
  console.table([
    {
      dbId: run.id,
      project: run.project,
      promptId: run.external_id,
      status: run.status,
      provider: run.provider,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      expected: run.expected_citation_count,
      captured: run.captured_citation_count,
      citationState: run.citation_state,
      error: run.error_code,
    },
  ]);
  console.log("Prompt:", run.prompt);
  console.log("Answer:", `${(run.answer || "").slice(0, 400)}${(run.answer || "").length > 400 ? "…" : ""}`);

  const citations = await query(
    `SELECT c.source_position AS pos, a.domain, a.normalized_domain AS norm_domain,
            c.relation_status, c.citation_marker, a.title
       FROM citations c
       JOIN articles a ON a.id = c.article_id
      WHERE c.run_id = $1
      ORDER BY c.source_position`,
    [run.id],
  );
  section(`Citations (${citations.length})`);
  console.table(citations);
}

async function promptRuns(promptText) {
  const rows = await query(
    `SELECT r.id AS db_id, r.local_run_id, r.status,
            r.expected_citation_count AS expected,
            r.captured_citation_count AS captured,
            r.started_at, r.error_code
       FROM runs r
       JOIN prompts p ON p.id = r.prompt_id
      WHERE p.prompt = $1
      ORDER BY r.started_at DESC`,
    [promptText],
  );
  section(`Run history for prompt (${rows.length})`);
  console.table(rows);
}

async function articleDetail(canonicalUrl) {
  const [article] = await query(`SELECT * FROM articles WHERE canonical_url = $1`, [canonicalUrl]);
  if (!article) {
    console.log(`article not found: ${canonicalUrl}`);
    return;
  }

  const [stats] = await query(
    `SELECT count(*) AS citation_count, count(DISTINCT run_id) AS run_count,
            min(created_at) AS first_cited_at, max(created_at) AS last_cited_at
       FROM citations WHERE article_id = $1`,
    [article.id],
  );

  section("Article");
  console.table([
    {
      id: article.id,
      domain: article.domain,
      normalizedDomain: article.normalized_domain,
      title: article.title,
      firstSeenAt: article.first_seen_at,
      lastSeenAt: article.last_seen_at,
      citations: stats.citation_count,
      runs: stats.run_count,
      firstCitedAt: stats.first_cited_at,
      lastCitedAt: stats.last_cited_at,
    },
  ]);

  const prompts = await query(
    `SELECT DISTINCT pr.name AS project, p.external_id, p.prompt, r.local_run_id, c.source_position AS pos
       FROM citations c
       JOIN runs r    ON r.id = c.run_id
       JOIN prompts p ON p.id = r.prompt_id
       JOIN projects pr ON pr.id = p.project_id
      WHERE c.article_id = $1
      ORDER BY r.local_run_id`,
    [article.id],
  );
  section(`Cited by (${prompts.length})`);
  console.table(prompts);
}

async function domains(limit) {
  const rows = await query(
    `SELECT a.normalized_domain AS domain,
            count(*)               AS citations,
            count(DISTINCT a.id)   AS articles,
            count(DISTINCT c.run_id) AS runs
       FROM citations c
       JOIN articles a ON a.id = c.article_id
      GROUP BY 1
      ORDER BY citations DESC, domain ASC
      LIMIT $1`,
    [limit],
  );
  section(`Domain aggregation (top ${rows.length})`);
  console.table(rows);
}

async function dedup() {
  const rows = await query(
    `SELECT a.canonical_url,
            a.normalized_domain AS domain,
            count(*)                   AS citations,
            count(DISTINCT c.run_id)   AS runs,
            count(DISTINCT p.id)       AS distinct_prompts,
            count(DISTINCT a.id)       AS article_rows
       FROM articles a
       JOIN citations c ON c.article_id = a.id
       JOIN runs r      ON r.id = c.run_id
       JOIN prompts p   ON p.id = r.prompt_id
      GROUP BY a.id
     HAVING count(DISTINCT p.id) > 1
      ORDER BY citations DESC
      LIMIT 25`,
  );
  section(`Articles cited by more than one prompt (${rows.length})`);
  console.table(rows);
  if (!rows.length) {
    console.log("No article has been cited by two different prompts yet.");
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    console.log(
      "usage: npm run db:query -- <overview|run|prompt|article|domains|dedup> [argument]",
    );
    return;
  }

  if (command === "overview") await overview();
  else if (command === "run") await runDetail(rest[0] ?? "");
  else if (command === "prompt") await promptRuns(rest.join(" "));
  else if (command === "article") await articleDetail(rest.join(" "));
  else if (command === "domains") await domains(Number(rest[0] ?? 20));
  else if (command === "dedup") await dedup();
  else throw new Error(`Unknown query command: ${command}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
