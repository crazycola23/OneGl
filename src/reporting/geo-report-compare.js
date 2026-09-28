import { ApiHttpError } from "../api/http.js";

/**
 * 两份 GEO 报告的横向对比。
 *
 * ## 设计边界：这个端点只给数字，不给结论
 *
 * 这里的输出是**结构化差异**，不含任何自然语言判断 —— 「覆盖率下降说明什么」
 * 「渠道迁移意味着该往哪投」这类结论由调用方的 agent 生成，用它自己的模型。
 * 理由很直接：解读依赖上下文和业务判断，OneGl 手里只有引用计数；把解读写进
 * 采集层，等于让测量系统替使用者做业务决策，而且一旦口径调整，解读文本
 * 就变成过期的错误结论。
 *
 * 所以这里做的是：**把两份快照的同口径数字对齐，算出差值，让 agent 拿着
 * 可信数据去写分析。**
 *
 * ## 缺值一律是 null，不补零
 *
 * 两个报告的平台集合可能不同（新增平台、平台下线）。缺失的指标返回 null
 * 并在 notes 里说明，绝不用 0 代替 —— 0 是一个「确实没有」的断言，
 * 混进对比会造出「某平台从 30 掉到 0」这种并不存在的断崖。
 */

function fail(message, status = 400, code = "invalid_request") {
  throw new ApiHttpError(status, code, message);
}

function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 只对两个都是数字的值算差值。任一为 null 则结果为 null，并记进 notes。 */
function delta(current, previous, { label, notes, noteCode }) {
  const c = num(current);
  const p = num(previous);
  if (c == null || p == null) {
    notes.push({ code: noteCode, metric: label, current: c, previous: p });
    return null;
  }
  return Math.round((c - p) * 10000) / 10000;
}

/** 比率型指标的百分点差。0.915 -> -3.2 表示下降 3.2 个百分点。 */
function percentagePointDelta(current, previous, { label, notes, noteCode }) {
  const c = num(current);
  const p = num(previous);
  if (c == null || p == null) {
    notes.push({ code: noteCode, metric: label, current: c, previous: p });
    return null;
  }
  return Math.round((c - p) * 10000) / 100;
}

/**
 * 一次查出报告的身份与快照。
 *
 * 之前是两个函数各查一次（loadSnapshot + loadSnapshotIdentity），
 * 同一份报告被 SELECT 两遍。合并后每份报告只查一次。
 *
 * 对外只暴露 public id，不暴露内部 task / group 主键。
 */
async function loadSnapshot(pool, { tenantId, reportPublicId }) {
  const { rows } = await pool.query(
    `SELECT r.public_id, r.created_at, r.group_id,
            t.public_id AS task_public_id, g.public_id AS group_public_id,
            rev.payload, rev.content_hash
       FROM service_geo_reports r
       LEFT JOIN service_tasks t ON t.id = r.task_id
       LEFT JOIN service_task_groups g ON g.id = r.group_id
       JOIN LATERAL (
         SELECT payload, content_hash FROM service_geo_report_revisions
          WHERE report_id = r.id AND tenant_id = $1 ORDER BY revision DESC LIMIT 1
       ) rev ON TRUE
      WHERE r.tenant_id = $1 AND r.public_id = $2`,
    [tenantId, reportPublicId],
  );
  const row = rows[0];
  if (!row) fail(`geo report was not found: ${reportPublicId}`, 404, "report_not_found");
  return {
    report_id: row.public_id,
    scope_kind: row.group_public_id ? "group" : "task",
    task_id: row.task_public_id ?? null,
    group_id: row.group_public_id ?? null,
    created_at: row.created_at,
    payload: row.payload,
    content_hash: row.content_hash,
  };
}

/**
 * 把快照摊平成 platform → 每个 period 的指标。
 *
 * ## 为什么按平台索引，而不是 period_key + platform
 *
 * 早期版本用 `${period.key}::${platform}` 作对齐键，实测**完全失效**：
 * period_key 是调用方在报告请求里自己填的字符串，两次生成报告几乎不可能填一样
 * （实测 `c1` vs `p1`）。结果是同一平台的两次采集对不上 ——
 * 一边被标成「已移除」、另一边被标成「新增」，`present_in_both` 全是 false，
 * **一个差值都算不出来**，而接口仍然返回 200。
 *
 * 业务上「这个平台这次 vs 那个平台那次」本来就是按平台比的；
 * 同一份报告内部的多次纵向对比已经由 comparePeriods 处理，不依赖这里。
 * 所以改为按平台对齐，period 只作为展示信息带出。
 */
function flatten(payload) {
  const byPlatform = new Map();
  for (const period of payload.periods ?? []) {
    for (const platform of period.platforms ?? []) {
      const list = byPlatform.get(platform.platform) ?? [];
      list.push({
        platform: platform.platform,
        period_key: period.key,
        period_label: period.label,
        period_from: period.from,
        period_to: period.to,
        runs: platform.runs,
        citations: platform.citations,
        questions: platform.questions,
      });
      byPlatform.set(platform.platform, list);
    }
  }
  return byPlatform;
}

/**
 * 取该平台下最接近 base 的一个 period。
 *
 * 「最接近」= 日期区间结束日最大且不超过 base 的结束日；没有则退回区间开始日最大者。
 * 这样按时间推进的多次采集能自然对上，而不是依赖调用方填一样的 key。
 */
function pickComparable(list, baseEntry) {
  if (!list.length) return null;
  const baseTo = baseEntry?.period_to ?? null;
  if (baseTo) {
    const before = list.filter((x) => !x.period_to || x.period_to <= baseTo);
    if (before.length) {
      return before.sort((a, b) => String(b.period_to).localeCompare(String(a.period_to)))[0];
    }
  }
  return list
    .slice()
    .sort((a, b) => String(b.period_from ?? b.period_to ?? "").localeCompare(String(a.period_from ?? a.period_to ?? "")))[0];
}

function comparePlatform(entry, prevEntry, { notes }) {
  const label = `${entry.platform}`;
  const citations = entry.citations ?? {};
  const tracked = citations.tracked_content ?? {};
  const prevCitations = prevEntry?.citations ?? {};
  const prevTracked = prevCitations.tracked_content ?? {};

  return {
    platform: entry.platform,
    // 两个 period 各自的时间区间与 key 都要带出来：调用方要能核对
    // 「对比的到底是哪两次采集」，而 key 是调用方自己填的，不能假设相同。
    period_key: entry.period_key,
    period_label: entry.period_label,
    period_from: entry.period_from,
    period_to: entry.period_to,
    base_period_key: prevEntry?.period_key ?? null,
    base_period_label: prevEntry?.period_label ?? null,
    base_period_from: prevEntry?.period_from ?? null,
    base_period_to: prevEntry?.period_to ?? null,
    present_in_both: Boolean(prevEntry),
    runs: {
      valid_runs: num(entry.runs?.valid_runs) ?? 0,
      valid_runs_delta: delta(entry.runs?.valid_runs, prevEntry?.runs?.valid_runs, {
        label: `${label}.valid_runs`, notes, noteCode: "missing_metric",
      }),
      success_rate: num(entry.runs?.success_rate),
      success_rate_delta: delta(entry.runs?.success_rate, prevEntry?.runs?.success_rate, {
        label: `${label}.success_rate`, notes, noteCode: "missing_metric",
      }),
      average_answer_characters: num(entry.runs?.average_answer_characters),
      average_answer_characters_delta: delta(
        entry.runs?.average_answer_characters,
        prevEntry?.runs?.average_answer_characters,
        { label: `${label}.average_answer_characters`, notes, noteCode: "missing_metric" },
      ),
      brand_mention_rate: num(entry.runs?.brand_mention_rate),
      brand_mention_rate_delta: percentagePointDelta(
        entry.runs?.brand_mention_rate,
        prevEntry?.runs?.brand_mention_rate,
        { label: `${label}.brand_mention_rate`, notes, noteCode: "missing_metric" },
      ),
    },
    citations: {
      visible: num(citations.visible_citations) ?? 0,
      visible_delta: delta(citations.visible_citations, prevCitations.visible_citations, {
        label: `${label}.visible_citations`, notes, noteCode: "missing_metric",
      }),
      unique_articles: num(citations.unique_articles) ?? 0,
      unique_articles_delta: delta(citations.unique_articles, prevCitations.unique_articles, {
        label: `${label}.unique_articles`, notes, noteCode: "missing_metric",
      }),
      unique_domains: num(citations.unique_domains) ?? 0,
      unique_domains_delta: delta(citations.unique_domains, prevCitations.unique_domains, {
        label: `${label}.unique_domains`, notes, noteCode: "missing_metric",
      }),
    },
    tracked_content: {
      configured_articles: num(tracked.configured_articles) ?? 0,
      cited_articles: num(tracked.cited_articles),
      coverage_rate: num(tracked.coverage_rate),
      coverage_rate_delta_percentage_points: percentagePointDelta(
        tracked.coverage_rate,
        prevTracked.coverage_rate,
        { label: `${label}.coverage_rate`, notes, noteCode: "missing_metric" },
      ),
      article_coverage_rate: num(tracked.article_coverage_rate),
      article_coverage_rate_delta_percentage_points: percentagePointDelta(
        tracked.article_coverage_rate,
        prevTracked.article_coverage_rate,
        { label: `${label}.article_coverage_rate`, notes, noteCode: "missing_metric" },
      ),
    },
    // 来源结构的变化是渠道策略调整的直接证据：哪些域进了、哪些退出了。
    top_domains: {
      current: (citations.top_domains ?? []).map((d) => ({ domain: d.domain, citations: num(d.citations), covered_runs: num(d.covered_runs) })),
      previous: (prevCitations.top_domains ?? []).map((d) => ({ domain: d.domain, citations: num(d.citations), covered_runs: num(d.covered_runs) })),
      entered: domainDiff(citations.top_domains, prevCitations.top_domains, "entered"),
      exited: domainDiff(citations.top_domains, prevCitations.top_domains, "exited"),
    },
  };
}

function domainDiff(currentDomains, previousDomains, kind) {
  const current = new Map((currentDomains ?? []).map((d) => [d.domain, d]));
  const previous = new Map((previousDomains ?? []).map((d) => [d.domain, d]));
  if (kind === "entered") {
    return [...current.entries()]
      .filter(([domain]) => !previous.has(domain))
      .map(([domain, d]) => ({ domain, citations: num(d.citations), covered_runs: num(d.covered_runs) }));
  }
  return [...previous.entries()]
    .filter(([domain]) => !current.has(domain))
    .map(([domain, d]) => ({ domain, citations: num(d.citations), covered_runs: num(d.covered_runs) }));
}

/**
 * 对比两份报告。
 *
 * **按平台对齐**，不用 period_key + platform：period_key 是调用方在报告请求里
 * 自己填的字符串，两次生成几乎不可能一样（实测 `c1` vs `p1`），拿它当对齐键会
 * 让同一平台的两次采集静默对不上 —— 一边标「已移除」、一边标「新增」，
 * `present_in_both` 全为 false，一个差值都算不出来，而接口照样返回 200。
 *
 * 一份报告含多个 period 时，取结束日最接近 base 的那一个（见 pickComparable）。
 *
 * 某平台只在一侧存在时 present_in_both = false 且指标为 null，让调用方能区分
 * 「指标下降了」和「这次压根没这个平台的样本」—— 两者在报告里长得一样，
 * 但在决策上完全不同。
 */
export async function compareGeoCustomerReports(pool, { tenantId, baseReportId, targetReportId }) {
  if (!baseReportId || !targetReportId) fail("base_report_id and target_report_id are required");
  if (baseReportId === targetReportId) {
    fail("base_report_id and target_report_id must be different reports", 422, "same_report");
  }

  // 两份报告各查一次即可：身份与快照在同一条 SELECT 里返回。
  const [base, target] = await Promise.all([
    loadSnapshot(pool, { tenantId, reportPublicId: baseReportId }),
    loadSnapshot(pool, { tenantId, reportPublicId: targetReportId }),
  ]);

  // 口径不同的两份报告不能直接比：tracked 配置数不同会让覆盖率不可比。
  const notes = [];
  if ((base.payload.target?.tracked_articles_count ?? 0) !== (target.payload.target?.tracked_articles_count ?? 0)) {
    notes.push({
      code: "tracked_articles_config_changed",
      message:
        `两份报告的目标内容配置数不同（${base.payload.target?.tracked_articles_count ?? 0} vs ` +
        `${target.payload.target?.tracked_articles_count ?? 0}），覆盖率类指标不可直接比较。`,
    });
  }
  if (base.scope_kind !== target.scope_kind) {
    notes.push({
      code: "scope_kind_mismatch",
      message: `两份报告的口径不同（${base.scope_kind} vs ${target.scope_kind}），请确认这是预期对比。`,
    });
  }
  // 品牌集合不同：提及率的分母（回答数）一样，但比的品牌不是同一批，
  // 「排名变了」可能只是换了观察对象。必须提示，否则容易被读成排名变化。
  const baseBrands = (base.payload.scope?.brands ?? []).map((b) => b.name).sort();
  const targetBrands = (target.payload.scope?.brands ?? []).map((b) => b.name).sort();
  if (baseBrands.length || targetBrands.length) {
    const baseSet = new Set(baseBrands);
    const targetSet = new Set(targetBrands);
    const added = targetBrands.filter((n) => !baseSet.has(n));
    const dropped = baseBrands.filter((n) => !targetSet.has(n));
    if (added.length || dropped.length) {
      notes.push({
        code: "brand_set_changed",
        message:
          "两份报告的品牌集合不同" +
          (added.length ? `；target 新增 ${added.join("、")}` : "") +
          (dropped.length ? `；base 独有 ${dropped.join("、")}` : "") +
          "。这些品牌没有可比数据，请勿把两侧排名直接对比。",
      });
    }
  }

  const baseFlat = flatten(base.payload);
  const targetFlat = flatten(target.payload);
  // 按平台遍历，而不是按 period_key+platform：period_key 由调用方自由填写，
  // 拿它当对齐键会让两次采集对不上（详见 flatten 的注释）。
  const platforms = [];
  const platformIds = [...new Set([...targetFlat.keys(), ...baseFlat.keys()])].sort();
  for (const platformId of platformIds) {
    const targetList = targetFlat.get(platformId) ?? [];
    const baseList = baseFlat.get(platformId) ?? [];
    if (!targetList.length) {
      // target 这次完全没有该平台的数据
      const removed = baseList[0];
      platforms.push({
        platform: platformId,
        present_in_both: false,
        present_in_target: false,
        removed_since_base: true,
        base_period_key: removed?.period_key ?? null,
        base_period_label: removed?.period_label ?? null,
        base_period_from: removed?.period_from ?? null,
        base_period_to: removed?.period_to ?? null,
      });
      continue;
    }
    // target 有多个 period 时，取最接近 base 的那个（通常是紧接着的一次采集）
    const entry = pickComparable(targetList, baseList[0]);
    platforms.push({
      ...comparePlatform(entry, pickComparable(baseList, entry), { notes }),
      present_in_target: true,
      removed_since_base: false,
    });
  }

  return {
    base: {
      report_id: base.report_id,
      scope_kind: base.scope_kind,
      task_id: base.task_id,
      group_id: base.group_id,
      generated_at: base.payload.generated_at,
      platforms: base.payload.scope?.platforms ?? [],
      periods: (base.payload.scope?.periods ?? []).map((p) => ({ key: p.key, label: p.label, from: p.from, to: p.to })),
    },
    target: {
      report_id: target.report_id,
      scope_kind: target.scope_kind,
      task_id: target.task_id,
      group_id: target.group_id,
      generated_at: target.payload.generated_at,
      platforms: target.payload.scope?.platforms ?? [],
      periods: (target.payload.scope?.periods ?? []).map((p) => ({ key: p.key, label: p.label, from: p.from, to: p.to })),
    },
    platforms,
    notes,
    // 明确声明这个端点不做什么，避免调用方误以为拿到的是结论。
    interpretation: {
      provided_by: "onegl",
      conclusion: null,
      guidance:
        "本端点只返回同口径指标的差值与来源结构变化，不含自然语言结论。" +
        "解读请由调用方用自己的模型生成。",
    },
  };
}
