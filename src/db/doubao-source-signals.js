import { summarizeDoubaoSourceSignals } from "../analysis/doubao-source-signals.js";

const VALID_RUN = "r.status IN ('success', 'partial') AND r.conversation_reset_confirmed IS TRUE";

function normalizeRows(rows) {
  return rows.map((row) => ({
    ...row,
    batch_id: Number(row.batch_id),
    article_id: Number(row.article_id),
  }));
}

export async function loadProjectDoubaoSourceSignals(pool, projectId, { from, to }) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (r.sampling_batch_id, a.id)
            r.sampling_batch_id AS batch_id,
            a.id AS article_id,
            a.normalized_domain AS domain,
            apo.fetch_state,
            apo.content_profile,
            apo.text_length,
            apo.h2_count,
            apo.table_count,
            apo.list_count,
            apo.faq_heading_count,
            apo.author_present,
            apo.published_at_raw,
            apo.brand_mentioned
       FROM citations c
       JOIN runs r ON r.id = c.run_id
       JOIN prompts p ON p.id = r.prompt_id
       JOIN articles a ON a.id = c.article_id
       LEFT JOIN article_page_observations apo
         ON apo.batch_id = r.sampling_batch_id AND apo.article_id = a.id
      WHERE p.project_id = $1
        AND r.provider = 'doubao'
        AND COALESCE(r.provider_access, 'scraped') = 'scraped'
        AND r.created_at >= $2
        AND r.created_at <= $3
        AND ${VALID_RUN}
        AND c.source_type = 'visible'
        AND c.visible_to_user IS TRUE
      ORDER BY r.sampling_batch_id, a.id, r.id DESC`,
    [projectId, from, to],
  );
  return summarizeDoubaoSourceSignals(normalizeRows(rows));
}

export async function loadBatchDoubaoSourceSignals(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (r.sampling_batch_id, a.id)
            r.sampling_batch_id AS batch_id,
            a.id AS article_id,
            a.normalized_domain AS domain,
            apo.fetch_state,
            apo.content_profile,
            apo.text_length,
            apo.h2_count,
            apo.table_count,
            apo.list_count,
            apo.faq_heading_count,
            apo.author_present,
            apo.published_at_raw,
            apo.brand_mentioned
       FROM citations c
       JOIN runs r ON r.id = c.run_id
       JOIN articles a ON a.id = c.article_id
       LEFT JOIN article_page_observations apo
         ON apo.batch_id = r.sampling_batch_id AND apo.article_id = a.id
      WHERE r.sampling_batch_id = $1
        AND r.provider = 'doubao'
        AND COALESCE(r.provider_access, 'scraped') = 'scraped'
        AND ${VALID_RUN}
        AND c.source_type = 'visible'
        AND c.visible_to_user IS TRUE
      ORDER BY r.sampling_batch_id, a.id, r.id DESC`,
    [batchId],
  );
  return summarizeDoubaoSourceSignals(normalizeRows(rows));
}
