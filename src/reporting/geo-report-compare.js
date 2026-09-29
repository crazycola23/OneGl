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
        // 品牌提及必须一起带出来：竞品提及率的两期变化正是「基于最近报告做对比」
        // 最想看的东西。不带的话，对比端点只有 runs.brand_mention_rate ——
        // 那是采集期按项目 target_brand 算的单一品牌口径，与报告请求里
        // brands 参数统计的竞品口径完全无关。
        brand_mentions: platform.brand_mentions ?? null,
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
 *
 * base 侧必须传**时间最早**的那个 period（见 earliestPeriod），不能用数组首个元素：
 * 调用方完全可以按任意顺序填 periods，用首元素会导致「基线(9月初)」被当成
 * 「最新一期」，进而把 target 的 9 月底数据和 base 的 9 月初数据配成一对 ——
 * 数字各自都对，配对是错的，且 notes 里没有任何提示。
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

/**
 * 竞品提及的两期对比。
 *
 * 三个必须说清的口径问题：
 *
 * 1. **匹配键是品牌名。** 同一品牌在两侧的 name 完全一致（调用方传的），别名不参与匹配 ——
 *    别名是匹配用的，跨期对齐必须用稳定标识。
 * 2. **缺一侧是 null 不是 0。** 品牌 A 只在 target 的 brands 里出现，base 侧就是「没统计过」，
 *    报 0 会被读成「以前提过、现在不提了」，那是完全不同的事。
 * 3. **分母可能不同。** 两期抽样的有效回答数不同（采样波动、失败率变化），提及率的
 *    变化可能来自分母而非品牌本身，所以两期分母都带出来，让调用方自己判断。
 */
function compareBrandMentions(current, previous, { label, notes }) {
  // 「没做品牌统计」与「统计了但品牌列表为空」要分开：
  // 前者拿不到任何对比数据，后者是真实的「这些品牌都没被提到」。
  const currentHas = Boolean(current?.available);
  const previousHas = Boolean(previous?.available);
  if (!currentHas || !previousHas) {
    return {
      available: false,
      reason: !currentHas
        ? "target report has no brand analysis (no brands supplied or no usable answers)"
        : "base report has no brand analysis (no brands supplied or no usable answers)",
      current_answer_count: num(current?.answer_count) ?? null,
      base_answer_count: num(previous?.answer_count) ?? null,
      brands: [],
    };
  }

  const currentMap = new Map((current.brands ?? []).map((b) => [b.name, b]));
  const previousMap = new Map((previous.brands ?? []).map((b) => [b.name, b]));
  const names = [...new Set([...currentMap.keys(), ...previousMap.keys()])];

  const brands = names
    .map((name) => {
      const c = currentMap.get(name) ?? null;
      const p = previousMap.get(name) ?? null;
      const comparable = Boolean(c && p);
      return {
        name,
        role: c?.role ?? p?.role ?? "unspecified",
        comparable,
        present_in_current: Boolean(c),
        present_in_base: Boolean(p),
        current: c
          ? {
              mention_rate: num(c.mention_rate),
              mentioned_answers: num(c.mentioned_answers),
              mention_count: num(c.mention_count),
              valid_answers: num(c.valid_answers),
            }
          : null,
        base: p
          ? {
              mention_rate: num(p.mention_rate),
              mentioned_answers: num(p.mentioned_answers),
              mention_count: num(p.mention_count),
              valid_answers: num(p.valid_answers),
            }
          : null,
        // 百分点差：提及率类指标用百分点而非百分比变化
        mention_rate_delta_percentage_points: comparable
          ? percentagePointDelta(c.mention_rate, p.mention_rate, {
              label: `${label}.${name}.mention_rate`,
              notes,
              noteCode: "missing_metric",
            })
          : null,
        mention_count_delta: comparable
          ? delta(c.mention_count, p.mention_count, {
              label: `${label}.${name}.mention_count`,
              notes,
              noteCode: "missing_metric",
            })
          : null,
      };
    })
    .sort((a, b) => {
      // 有可比数据的排前面，再按提及率变化绝对值（波动最大的最值得看）
      if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
      const da = a.mention_rate_delta_percentage_points == null ? -1 : Math.abs(a.mention_rate_delta_percentage_points);
      const db = b.mention_rate_delta_percentage_points == null ? -1 : Math.abs(b.mention_rate_delta_percentage_points);
      if (da !== db) return db - da;
      return (b.current?.mention_rate ?? -1) - (a.current?.mention_rate ?? -1);
    });

  // 显著性标记：确定性计算，不是判断。
  //
  // agent 拿到 Δ=0 时无从区分「这个竞品的地位真的没变」和「变化被采样波动淹没了」，
  // 于是要么把所有 0 都当噪音、要么把 0.4 个百分点的小波动当趋势。
  //
  // 判据是可复算的：
  //   1. 最小分母决定比率变化的分辨率 —— 20 条回答里变化 1 条 = 5 个百分点，
  //      80 条里变化 1 条 = 1.25 个百分点，数字一样但可信度完全不同
  //   2. Δ 超过这个分辨率才算「可测的变化」
  // 3. 分母大幅变化时整体标注不可比（采样波动可能盖过真实变化）
  //
  // 只标状态不给建议：该不该据此行动是调用方模型的判断，不是这里的。
  const currentN = num(current.answer_count);
  const baseN = num(previous.answer_count);
  const denominatorChanged = currentN != null && baseN != null && currentN !== baseN;
  // 用较小的一侧算分辨率：保守，避免把小样本的波动说成趋势
  const smallerN = Math.min(currentN ?? 0, baseN ?? 0);
  const resolution = smallerN > 0 ? (100 / smallerN) : null;

  const ranked = brands.map((entry) => {
    if (!entry.comparable) {
      return { ...entry, movement: "not_comparable", resolution_percentage_points: null };
    }
    const delta = entry.mention_rate_delta_percentage_points;
    if (delta == null || resolution == null) {
      return { ...entry, movement: "unknown", resolution_percentage_points: resolution };
    }
    // 「两期都是 0」与「两期相同但非 0」必须分开。
    //
    // 早期版本都归为 flat，agent 于是会读成「这个竞品的势头稳定」——
    // 而事实是「这个品牌两期都没被 AI 提到」。前者是竞争态势，
    // 后者是存在感缺失，要采取的行动完全相反。
    if ((entry.base?.mention_rate ?? 0) === 0 && (entry.current?.mention_rate ?? 0) === 0) {
      return { ...entry, movement: "absent_both", resolution_percentage_points: resolution };
    }
    if (Math.abs(delta) < 0.05) {
      // 浮点上完全相等也会落到这里，避免给出 0.0 之后的噪音判断
      return { ...entry, movement: "flat", resolution_percentage_points: resolution };
    }
    if (Math.abs(delta) < resolution) {
      // 变化存在但小于采样分辨率 —— 典型是「只差一条回答」
      return { ...entry, movement: "within_noise", resolution_percentage_points: resolution };
    }
    return {
      ...entry,
      movement: delta > 0 ? "gained" : "declined",
      resolution_percentage_points: resolution,
    };
  });

  // 分组里带 Δ 值而不只是名字。
  //
  // 只给名字的话，agent 拿到 `gained: ["A", "B"]` 无法知道谁涨得多，
  // 必须反查 brands 数组再自己排一次 —— 而 brands 是按 |Δ| 降序的，
  // 跨分组后这个顺序就丢了（gained 组里最小 Δ 可能大于 declined 组里最大 Δ）。
  // 每组内部按 Δ 的绝对值降序，与 brands 的主排序一致。
  const group = (kind) => ranked
    .filter((b) => b.movement === kind)
    .sort((a, b) => Math.abs(b.mention_rate_delta_percentage_points ?? 0)
                  - Math.abs(a.mention_rate_delta_percentage_points ?? 0))
    .map((b) => ({
      name: b.name,
      mention_rate_delta_percentage_points: b.mention_rate_delta_percentage_points,
      base_mention_rate: b.base?.mention_rate ?? null,
      current_mention_rate: b.current?.mention_rate ?? null,
    }));

  const summary = {
    gained: group("gained"),
    declined: group("declined"),
    within_noise: group("within_noise"),
    absent_both: group("absent_both"),
    flat: group("flat"),
    not_comparable: group("not_comparable"),
  };

  return {
    available: true,
    reason: null,
    current_answer_count: currentN,
    base_answer_count: baseN,
    // 分母不一致时提醒：提及率变化可能来自样本波动而非品牌表现
    denominator_changed: denominatorChanged,
    // 变化可被采样分辨的最小百分点：|Δ| 小于此值时不应解读为趋势
    resolution_percentage_points: resolution,
    // 按运动方向分组。只列名字，不含建议 —— 行动判断归调用方模型。
    movement: summary,
    brands: ranked,
    interpretation: {
      provided_by: "onegl",
      role: "mention_movement",
      conclusion: null,
      guidance:
        "movement 按变化方向分组，每组按 |Δ| 降序、组内带 Δ 值与两期提及率，" +
        "不必反查 brands 数组。gained / declined 是超过采样分辨率的真实变化，" +
        "within_noise 是存在差异但小于分辨率（通常只差一两条回答），" +
        "flat 是两期提及率相同的**非零**值，absent_both 是两期都没被提到 —— " +
        "后者不是「势头稳定」而是「没有存在感」，要采取的行动完全不同。" +
        "not_comparable 是只在单侧出现。" +
        (denominatorChanged
          ? "本次两期分母不同，变化可能部分来自采样波动而非品牌表现。"
          : "") +
        "这些是确定性判定，是否据此行动由你的模型判断。",
    },
  };
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
    // 竞品提及的两期对比。
    //
    // 匹配键是品牌名：两侧 brands 列表不同的品牌只出现在一侧，另一侧给 null
    // 而不是 0 —— 「这次没统计这个品牌」和「统计了但没提到」必须能区分。
    // 调用方若忽略 notes 里的 brand_set_changed 就直接比排名，会得到错误结论，
    // 所以这里同时给出可比性标记。
    brand_mentions: compareBrandMentions(entry.brand_mentions, prevEntry?.brand_mentions, {
      label,
      notes,
    }),
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
/** 时间最早的 period：作为「基线」参与配对，而不是数组首个元素。 */
function earliestPeriod(list) {
  if (!list.length) return null;
  return list
    .slice()
    .sort((a, b) =>
      String(a.period_from ?? a.period_to ?? "")
        .localeCompare(String(b.period_from ?? b.period_to ?? "")),
    )[0];
}

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
    // 基线取时间最早的 period，不是数组首个 —— 调用方填 periods 的顺序是自由的
    const baseAnchor = earliestPeriod(baseList);
    if (!targetList.length) {
      // target 这次完全没有该平台的数据。
      //
      // 必须给出与正常分支**同构**的对象：客户端通常写
      // `for (const p of resp.platforms) p.runs.valid_runs`，若这里只给
      // `{platform, present_in_both}`，访问 p.runs 就是 undefined，再下一层直接抛
      // TypeError —— 整个响应遍历到这一项就中断。指标一律给 null 而非 0：
      // 「没采到」不是「采到了 0」。
      const removed = baseAnchor;
      platforms.push({
        platform: platformId,
        period_key: null,
        period_label: null,
        period_from: null,
        period_to: null,
        base_period_key: removed?.period_key ?? null,
        base_period_label: removed?.period_label ?? null,
        base_period_from: removed?.period_from ?? null,
        base_period_to: removed?.period_to ?? null,
        present_in_both: false,
        present_in_target: false,
        removed_since_base: true,
        runs: null,
        citations: null,
        tracked_content: null,
        brand_mentions: null,
        top_domains: null,
      });
      continue;
    }
    // target 有多个 period 时，取最接近基线的那个（通常是紧接着的一次采集）
    const entry = pickComparable(targetList, baseAnchor);
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
