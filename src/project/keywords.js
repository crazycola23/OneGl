/**
 * 关键词池的人工录入与维护。
 *
 * 录入规则（与产品需求一一对应）：
 *   - 分隔符为 #（同时兼容全角 ＃ 与换行，便于直接粘贴多行文本）
 *   - 每项去掉首尾空白
 *   - 忽略空项
 *   - 同一项目内去重，保留首次出现的顺序
 *   - 不改动关键词正文，中文标点原样保留
 *
 * 去重与唯一约束都基于 project_id，不同项目可以存在同名关键词。
 */

const SEPARATORS = /[#＃\r\n]+/;

export function parseKeywordInput(input) {
  const raw = String(input ?? "");
  const seen = new Set();
  const keywords = [];
  const duplicates = [];

  for (const piece of raw.split(SEPARATORS)) {
    // 只去掉首尾空白并丢弃空项，正文（含中文标点）不做任何加工
    const keyword = piece.trim();
    if (!keyword) continue;

    if (seen.has(keyword)) {
      duplicates.push(keyword);
      continue;
    }
    seen.add(keyword);
    keywords.push(keyword);
  }

  return { keywords, duplicates };
}

const REVIVE_KEYWORD = `
  INSERT INTO prompts (project_id, prompt, category, source, enabled)
  VALUES ($1, $2, $3, 'manual', true)
  ON CONFLICT (project_id, prompt_md5) WHERE external_id IS NULL DO UPDATE
    SET updated_at = now(),
        deleted_at = NULL,
        enabled = true,
        category = COALESCE(EXCLUDED.category, prompts.category),
        source = CASE WHEN prompts.source = 'pool' THEN prompts.source ELSE 'manual' END
  RETURNING id, (xmax = 0) AS inserted
`;

/**
 * SaaS batches may submit the same question text more than once when each submission is a
 * separate observation. `external_id` is the only thing that tells those rows apart, so the
 * upsert key has to include it. prompts_project_prompt_external_key (migration 0023) is the
 * partial unique index this conflict target infers.
 */
const REVIVE_KEYWORD_WITH_EXTERNAL_ID = `
  INSERT INTO prompts (project_id, prompt, category, source, enabled, external_id)
  VALUES ($1, $2, $3, 'manual', true, $4)
  ON CONFLICT (project_id, prompt_md5, external_id) WHERE external_id IS NOT NULL DO UPDATE
    SET updated_at = now(),
        deleted_at = NULL,
        enabled = true,
        category = COALESCE(EXCLUDED.category, prompts.category),
        source = CASE WHEN prompts.source = 'pool' THEN prompts.source ELSE 'manual' END
  RETURNING id, (xmax = 0) AS inserted
`;

async function reviveKeyword(client, { projectId, keyword, category = null, externalId = null }) {
  return externalId
    ? client.query(REVIVE_KEYWORD_WITH_EXTERNAL_ID, [projectId, keyword, category, externalId])
    : client.query(REVIVE_KEYWORD, [projectId, keyword, category]);
}

async function writeKeywords(client, { projectId, input, category = null }) {
  const { keywords, duplicates } = parseKeywordInput(input);
  if (!keywords.length) {
    return { added: 0, revived: 0, duplicates: duplicates.length, skipped: 0, keywords: [] };
  }

  const saved = [];
  let added = 0;
  let revived = 0;
  for (const keyword of keywords) {
    const result = await reviveKeyword(client, { projectId, keyword, category });
    if (result.rows[0].inserted) added += 1;
    else revived += 1;
    saved.push({ id: Number(result.rows[0].id), keyword, isNew: result.rows[0].inserted });
  }

  return {
    added,
    revived,
    duplicates: duplicates.length,
    skipped: keywords.length - saved.length,
    keywords: saved,
  };
}

/**
 * Write an already-parsed question list. Unlike {@link writeKeywords} this never de-duplicates
 * by text: identity is (text, external_id), which is what lets a caller send the same question
 * once per repetition and still get one result row per observation.
 *
 * `entries` is `[{ text, externalId?, category? }]` in caller order. The returned `keywords`
 * are `[{ id, keyword, externalId, isNew }]` in the same order.
 */
export async function writeQuestionEntries(client, { projectId, entries = [] }) {
  const saved = [];
  let added = 0;
  let revived = 0;
  for (const entry of entries) {
    const keyword = String(entry?.text ?? "").trim();
    if (!keyword) continue;
    const externalId = entry?.externalId == null ? null : String(entry.externalId).trim() || null;
    const result = await reviveKeyword(client, {
      projectId,
      keyword,
      category: entry?.category ?? null,
      externalId,
    });
    if (result.rows[0].inserted) added += 1;
    else revived += 1;
    saved.push({
      id: Number(result.rows[0].id),
      keyword,
      externalId,
      isNew: Boolean(result.rows[0].inserted),
    });
  }
  return { added, revived, duplicates: 0, skipped: 0, keywords: saved };
}

/**
 * Write a question entry list using a caller-owned PostgreSQL transaction.
 */
export async function addQuestionEntriesInTransaction(client, args) {
  return writeQuestionEntries(client, args);
}

export async function addQuestionEntries(pool, args) {
  if (typeof pool?.release === "function") return writeQuestionEntries(pool, args);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await writeQuestionEntries(client, args);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Write keywords using a caller-owned PostgreSQL transaction.
 * The caller is responsible for BEGIN/COMMIT/ROLLBACK and releasing the client.
 */
export async function addKeywordsInTransaction(client, args) {
  return writeKeywords(client, args);
}

export async function addKeywords(pool, args) {
  // A pg PoolClient has release(); a Pool does not. When a caller already owns the
  // transaction, write directly through that client instead of nesting BEGIN/COMMIT.
  if (typeof pool?.release === "function") return writeKeywords(pool, args);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await writeKeywords(client, args);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listProjectKeywords(pool, projectId) {
  const { rows } = await pool.query(
    `SELECT p.id,
            p.prompt,
            p.category,
            p.enabled,
            p.source,
            p.created_at,
            p.updated_at,
            p.deleted_at,
            count(r.id)                   AS run_count,
            count(DISTINCT c.id)          AS citation_count,
            max(b.created_at)             AS last_sampled_at
       FROM prompts p
       LEFT JOIN runs r ON r.prompt_id = p.id
       LEFT JOIN citations c ON c.run_id = r.id
       LEFT JOIN sampling_batch_prompts sbp ON sbp.prompt_id = p.id
       LEFT JOIN sampling_batches b ON b.id = sbp.batch_id
      WHERE p.project_id = $1
      GROUP BY p.id
      ORDER BY p.deleted_at IS NOT NULL, p.enabled DESC, p.created_at DESC, p.prompt`,
    [projectId],
  );
  return rows;
}

export async function setKeywordEnabled(pool, { projectId, promptId, enabled }) {
  const { rowCount } = await pool.query(
    `UPDATE prompts
        SET enabled = $3, updated_at = now()
      WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
    [promptId, projectId, enabled],
  );
  return rowCount > 0;
}

/**
 * 软删除。关键词行保留，因为 runs 与 sampling_batch_prompts 都引用它：
 * 硬删会让历史运行记录一起消失。
 */
export async function deleteKeyword(pool, { projectId, promptId }) {
  const { rowCount } = await pool.query(
    `UPDATE prompts
        SET deleted_at = now(), enabled = false, updated_at = now()
      WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
    [promptId, projectId],
  );
  return rowCount > 0;
}

/** 恢复被软删除的关键词。若同项目同关键词已存在活行，唯一约束会拦住重复插入。 */
export async function restoreKeyword(pool, { projectId, promptId }) {
  const { rowCount } = await pool.query(
    `UPDATE prompts
        SET deleted_at = NULL, enabled = true, updated_at = now()
      WHERE id = $1 AND project_id = $2 AND deleted_at IS NOT NULL`,
    [promptId, projectId],
  );
  return rowCount > 0;
}

export async function countActiveKeywords(pool, projectId) {
  const [row] = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE deleted_at IS NULL)                      AS total,
              count(*) FILTER (WHERE deleted_at IS NULL AND enabled)          AS enabled,
              count(*) FILTER (WHERE deleted_at IS NOT NULL)                  AS deleted
         FROM prompts
        WHERE project_id = $1`,
      [projectId],
    )
  ).rows;
  return {
    total: Number(row.total),
    enabled: Number(row.enabled),
    deleted: Number(row.deleted),
  };
}
