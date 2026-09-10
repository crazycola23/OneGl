import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeDomain } from "../db/domain.js";
import { ensureAccounts } from "../db/persist.js";
import { loadPoolFile, poolSummary } from "../sampling/pool.js";
import { canonicalizeUrl, domainFromUrl } from "../url.js";

/**
 * Bootstraps a monitoring project from a single config file:
 * target brand + alias rules, keyword pool, accounts, tracked articles.
 *
 * Re-running it is safe: every write is an upsert, so evolving the pool or the alias
 * rules does not duplicate anything and does not disturb runs already recorded.
 */

export async function loadProjectConfig(filePath) {
  const raw = await readFile(filePath, "utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`项目配置文件 ${filePath} 不是合法的 JSON：${error.message}`);
  }

  const project = String(payload?.project ?? payload?.name ?? "").trim();
  if (!project) throw new Error("项目配置文件缺少项目名称（project）");

  const brand = payload?.brand ?? {};
  const brandName = String(brand.name ?? project).trim();

  return {
    project,
    description: payload.description ?? null,
    provider: String(payload.provider ?? "doubao").trim(),
    brand: {
      name: brandName,
      aliases: Array.isArray(brand.aliases) ? brand.aliases : [],
      productAliases: Array.isArray(brand.productAliases) ? brand.productAliases : [],
      excludePatterns: Array.isArray(brand.excludePatterns) ? brand.excludePatterns : [],
    },
    accounts: Array.isArray(payload.accounts) ? payload.accounts.map(String) : [],
    pool: payload.keywordPool ?? null,
    trackedArticles: Array.isArray(payload.trackedArticles) ? payload.trackedArticles : [],
    baseDir: path.dirname(path.resolve(filePath)),
  };
}

const PROJECT_UPSERT = `
  INSERT INTO projects (
    name, description, target_brand, brand_aliases, brand_product_aliases, brand_exclude_patterns
  )
  VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
  ON CONFLICT (name) DO UPDATE
    SET updated_at = now(),
        description = COALESCE(EXCLUDED.description, projects.description),
        target_brand = EXCLUDED.target_brand,
        brand_aliases = EXCLUDED.brand_aliases,
        brand_product_aliases = EXCLUDED.brand_product_aliases,
        brand_exclude_patterns = EXCLUDED.brand_exclude_patterns
  RETURNING id
`;

const PROMPT_POOL_UPSERT = `
  INSERT INTO prompts (project_id, prompt, category, pool_version, source)
  VALUES ($1, $2, $3, $4, 'pool')
  ON CONFLICT (project_id, prompt_md5) DO UPDATE
    SET updated_at = now(),
        category = COALESCE(EXCLUDED.category, prompts.category),
        pool_version = COALESCE(EXCLUDED.pool_version, prompts.pool_version),
        source = 'pool',
        -- 重新导入池时把之前删除过的关键词恢复，避免「导入后仍然看不到」
        deleted_at = NULL
  RETURNING id
`;

const TRACKED_ARTICLE_UPSERT = `
  INSERT INTO tracked_articles (
    project_id, canonical_url, original_url, title, domain, normalized_domain, brand
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (project_id, canonical_url) DO UPDATE
    SET updated_at = now(),
        title = COALESCE(EXCLUDED.title, tracked_articles.title),
        brand = COALESCE(EXCLUDED.brand, tracked_articles.brand)
  RETURNING id
`;

export async function applyProjectConfig(pool, config, { log = console.log } = {}) {
  const client = await pool.connect();
  const summary = {
    projectId: null,
    poolTotal: 0,
    poolImported: 0,
    categories: [],
    accounts: [],
    trackedArticles: 0,
    backfilledCitations: 0,
  };

  try {
    await client.query("BEGIN");

    const projectResult = await client.query(PROJECT_UPSERT, [
      config.project,
      config.description,
      config.brand.name,
      JSON.stringify(config.brand.aliases),
      JSON.stringify(config.brand.productAliases),
      JSON.stringify(config.brand.excludePatterns),
    ]);
    summary.projectId = projectResult.rows[0].id;
    log(`项目：${config.project}（数据库ID=${summary.projectId}）`);

    // ------------------------------------------------------------ keyword pool
    if (config.pool) {
      const poolFile = path.isAbsolute(config.pool.file ?? "")
        ? config.pool.file
        : path.join(config.baseDir, config.pool.file ?? "");
      const { version, prompts, duplicateCount } = await loadPoolFile(
        poolFile,
        config.pool.version ?? null,
      );
      const stats = poolSummary(prompts);
      summary.poolTotal = stats.total;
      summary.categories = stats.categories;

      for (const prompt of prompts) {
        await client.query(PROMPT_POOL_UPSERT, [
          summary.projectId,
          prompt.text,
          prompt.category,
          version,
        ]);
        summary.poolImported += 1;
      }
      log(
        `关键词池：${stats.total} 条提问，${stats.categories.length} 个分类` +
          (duplicateCount ? `（跳过重复 ${duplicateCount} 条）` : ""),
      );
    }

    // ------------------------------------------------------------ tracked articles
    let tracked = 0;
    for (const article of config.trackedArticles) {
      const originalUrl = String(article?.url ?? "").trim();
      const canonicalUrl = canonicalizeUrl(originalUrl);
      if (!canonicalUrl) {
        log(`跳过无法解析的监控文章链接：${originalUrl}`);
        continue;
      }
      const domain = article.domain ?? domainFromUrl(canonicalUrl);
      await client.query(TRACKED_ARTICLE_UPSERT, [
        summary.projectId,
        canonicalUrl,
        originalUrl,
        article.title ?? null,
        domain,
        normalizeDomain(domain),
        article.brand ?? config.brand.name,
      ]);
      tracked += 1;
    }
    summary.trackedArticles = tracked;
    log(`监控文章：${tracked} 篇`);

    // Attach already captured citations whose canonical URL matches a tracked article,
    // so the tracked-article report is meaningful from the moment tracking is added.
    const backfill = await client.query(
      `UPDATE citations c
          SET tracked_article_id = t.id
         FROM articles a, tracked_articles t, runs r, prompts p
        WHERE c.article_id = a.id
          AND c.run_id = r.id
          AND r.prompt_id = p.id
          AND p.project_id = t.project_id
          AND t.project_id = $1
          AND a.canonical_url = t.canonical_url
          AND c.tracked_article_id IS DISTINCT FROM t.id`,
      [summary.projectId],
    );
    summary.backfilledCitations = backfill.rowCount;

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // ------------------------------------------------------------ accounts
  if (config.accounts.length) {
    summary.accounts = await ensureAccounts(pool, {
      accountKeys: config.accounts,
      provider: config.provider,
    });
    log(`账号：${config.accounts.join("，")}`);
  }

  return summary;
}

export async function loadBrandRules(pool, projectName) {
  const { rows } = await pool.query(
    `SELECT id, name, target_brand, brand_aliases, brand_product_aliases, brand_exclude_patterns
       FROM projects WHERE name = $1`,
    [projectName],
  );
  const project = rows[0];
  if (!project) throw new Error(`未找到项目「${projectName}」`);
  return {
    projectId: project.id,
    projectName: project.name,
    brand: {
      name: project.target_brand ?? "",
      aliases: project.brand_aliases ?? [],
      productAliases: project.brand_product_aliases ?? [],
      excludePatterns: project.brand_exclude_patterns ?? [],
    },
  };
}
