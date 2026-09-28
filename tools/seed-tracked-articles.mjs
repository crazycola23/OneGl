import { pathToFileURL } from "node:url";

import "dotenv/config";

import { createPool, isDatabaseConfigured } from "../src/db/pool.js";
import { listTaskGroups, resolveReportScope } from "../src/tasks/groups.js";

/**
 * 从历史引用里推荐目标内容（tracked_articles），让报告的「目标内容覆盖率」算得出来。
 *
 * ## 为什么需要它
 *
 * GEO 报告里的覆盖率类指标（目标内容被引用了多少、覆盖了多少条回答）分母来自
 * tracked_articles。全库 0 条配置时这些指标全是 null，报告里最关键的一组结论
 * 直接缺失。而人工配置目标内容有个现实问题：使用者一开始并不知道哪些 URL
 * 值得盯 —— 那正是 GEO 要回答的问题。
 *
 * ## 推荐口径
 *
 * 按「覆盖回答数」降序，不按引用总次数。引用总数会被少数爆款内容拉高，
 * 覆盖回答数才代表「有多少次真实提问里它出现过」，这才是覆盖率分母该有的样子。
 *
 * 同一篇文章常同时属于组内多个 project（每个平台一个），按 canonical_url 去重后
 * 再逐个 project 写入 —— 报告层会跨 project 合并去重，两边都写是安全的。
 *
 * 用法：
 *   node tools/seed-tracked-articles.mjs                     # 干跑，列出候选
 *   node tools/seed-tracked-articles.mjs --group grp_xxx --apply
 */

function parseArgs(argv) {
  const out = { apply: false, groupId: null, limit: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--group") {
      const v = argv[i + 1];
      if (!v) throw new Error("--group 需要一个 group_id");
      out.groupId = v;
      i += 1;
    } else if (arg === "--limit") {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v < 1 || v > 500) throw new Error("--limit 需要 1..500 的整数");
      out.limit = v;
      i += 1;
    } else throw new Error(`未知参数 ${arg}`);
  }
  return out;
}

/**
 * 不作为内容来源的域名。
 *
 * 两类：
 *   1. 图标 / 静态资源 CDN —— 引用条里混着来源图标本身（从图标地址解出的图片 URL），
 *      它们不是内容来源。报告口径也排除同一批域名。
 *   2. 通用的对象存储 / 图床域名 —— 同一批文章常挂在 gw.alicdn.com 之类的域下，
 *      把它们当「目标内容」会让覆盖率指标失真。
 *
 * 精确匹配 normalized_domain，不用后缀匹配：后缀匹配会把 legit 的
 * `cdn.example.com` 之类也一起排除掉。
 */
const NON_CONTENT_DOMAINS = Object.freeze([
  "cdn.sm.cn",
  "gw.alicdn.com",
  "alicdn.com",
  "sm.cn",
  "img.alicdn.com",
  "mmbiz.qpic.cn",
  "p.qpic.cn",
]);

/**
 * 候选目标内容。
 *
 * 限定在 citation 证据可信的运行上（口径见 db/citation-validity.js），
 * 否则会把「抓取失败那次恰好引用了某页」也算成推荐依据。
 */
async function candidates(pool, batchIds, limit) {
  const { rows } = await pool.query(
    `SELECT a.canonical_url,
            max(a.original_url)  AS original_url,
            max(a.title)          AS title,
            max(a.normalized_domain) AS domain,
            count(*)::int         AS citations,
            count(DISTINCT r.id)::int AS covered_runs
       FROM citations c
       JOIN articles a ON a.id = c.article_id
       JOIN runs r     ON r.id = c.run_id
      WHERE c.source_type = 'visible' AND c.visible_to_user IS TRUE
        AND r.status = 'success'
        AND r.conversation_reset_confirmed IS TRUE
        AND r.citation_state IN ('found', 'ok', 'none_visible', 'dom-only')
        -- 图标域 / 静态资源域不是内容来源
        AND lower(COALESCE(a.normalized_domain, '')) <> ALL($3::text[])
        AND a.canonical_url IS NOT NULL AND a.canonical_url <> ''
        AND r.sampling_batch_id = ANY($1::bigint[])
      GROUP BY a.canonical_url
      ORDER BY covered_runs DESC, citations DESC, a.canonical_url
      LIMIT $2`,
    [batchIds, limit, NON_CONTENT_DOMAINS],
  );
  return rows;
}

async function seed(pool, { groupId, limit, apply, log = console.log }) {
  // 目标 project 集合：给了 group 就取组内全部，否则全库有租户归属的 project
  let projectIds;
  let label;
  if (groupId) {
    const scope = await resolveReportScope(pool, { tenantId: 1, groupId });
    projectIds = scope.projects.map((p) => p.project_id);
    label = `组 ${scope.public_id}（${scope.name}）`;
  } else {
    const { rows } = await pool.query("SELECT DISTINCT project_id FROM service_project_bindings");
    projectIds = rows.map((r) => Number(r.project_id));
    label = `全部已绑定租户的项目（${projectIds.length} 个）`;
  }

  // 只从这些 project 自己的历史引用里推荐：先按 project 找批次，再按批次找引用。
  const { rows: scoped } = await pool.query(
    `SELECT DISTINCT b.id AS batch_id
       FROM sampling_batches b
       JOIN service_task_executions e ON e.batch_id = b.id
      WHERE b.project_id = ANY($1::bigint[])`,
    [projectIds],
  );
  const batchIds = scoped.map((r) => Number(r.batch_id));

  if (!batchIds.length) {
    log("目标 project 下没有采集批次，无候选内容。");
    return { candidates: [], inserted: 0 };
  }

  const rows = await candidates(pool, batchIds, limit);

  log(`\n目标范围：${label}`);
  log(`项目 ${projectIds.length} 个，批次 ${batchIds.length} 个`);
  log(`\n候选目标内容（按覆盖回答数排序，取前 ${rows.length}）：\n`);
  console.table(
    rows.map((r) => ({
      覆盖回答: r.covered_runs,
      引用: r.citations,
      域名: r.domain,
      标题: (r.title ?? "").slice(0, 34) || "(无标题)",
    })),
  );

  if (!apply) {
    log("\n这是干跑。加 --apply 写入 tracked_articles。");
    return { candidates: rows, inserted: 0 };
  }

  let inserted = 0;
  for (const projectId of projectIds) {
    for (const row of rows) {
      const res = await pool.query(
        `INSERT INTO tracked_articles
           (project_id, canonical_url, original_url, title, domain, normalized_domain, brand, enabled)
         VALUES ($1, $2, $3, $4, $5, $5, $6, TRUE)
         ON CONFLICT (project_id, canonical_url) DO UPDATE
           SET title = EXCLUDED.title, normalized_domain = EXCLUDED.normalized_domain, enabled = TRUE`,
        [projectId, row.canonical_url, row.original_url ?? row.canonical_url, row.title ?? null, row.domain ?? null, null],
      );
      inserted += res.rowCount;
    }
  }
  log(`\n已写入 ${inserted} 行（${rows.length} 篇 × ${projectIds.length} 个 project）`);
  return { candidates: rows, inserted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL 未配置。");
    process.exitCode = 1;
  } else {
    const args = parseArgs(process.argv.slice(2));
    const pool = createPool();
    try {
      const { inserted } = await seed(pool, args);
      if (args.apply) {
        const { rows } = await pool.query(
          `SELECT project_id, count(*)::int n FROM tracked_articles WHERE enabled IS TRUE
            GROUP BY project_id ORDER BY project_id`,
        );
        console.log("\n当前配置：");
        console.table(rows);
      }
    } catch (error) {
      console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}

export { seed, candidates };
