function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validObservedRun(run) {
  return ["success", "partial"].includes(run?.status) && run?.conversation_reset_confirmed === true;
}

function citationValidObservedRun(run) {
  if (run?.status !== "success" || run?.conversation_reset_confirmed !== true) return false;
  const state = run?.citation_state ?? run?.citationState;
  if (state == null || state === "") {
    return numberOrNull(run?.captured_citation_count ?? run?.capturedCitationCount) != null;
  }
  return ["found", "none_visible"].includes(state);
}

function promptState(row) {
  if (row.validRuns <= 0) {
    return {
      key: "DATA_GAP",
      label: "数据不足",
      priority: "P0",
      rank: 0,
      action: "先补跑或修复无效 Run；没有有效回答时不要据此改内容。",
    };
  }
  if (row.mentionedRuns === 0) {
    return {
      key: "NO_MENTION",
      label: "未被提及",
      priority: "P1",
      rank: 1,
      action: "优先检查该问题意图下的实体覆盖、直接回答与内容缺口，并保持原 Prompt 复测。",
    };
  }
  if (row.mentionRate < 0.5) {
    return {
      key: "WEAK_MENTION",
      label: "低频提及",
      priority: "P1",
      rank: 2,
      action: "作为重点调优问题；先做小范围内容改版，再用相同 Prompt 重复验证。",
    };
  }
  if (row.mentionRate < 1) {
    return {
      key: "UNSTABLE_MENTION",
      label: "提及不稳定",
      priority: "P2",
      rank: 3,
      action: "继续固定 Prompt、账号与时间窗复测，确认随机性和个性化影响。",
    };
  }
  return {
    key: "STABLE_MENTION",
    label: "当前稳定提及",
    priority: "WATCH",
    rank: 4,
    action: "保留为对照组，避免无必要改动；观察后续批次是否维持。",
  };
}

/**
 * Derive prompt-level opportunities only from observable run fields already present in
 * `/api/batches/<id>`. This deliberately does NOT build a query->source edge.
 */
export function buildPromptOpportunities(detail, { maxRows = 30 } = {}) {
  const runs = Array.isArray(detail?.runs) ? detail.runs : [];
  const assignmentCount = Number(detail?.report?.runs?.assignmentsRun ?? runs.length ?? 0);
  const groups = new Map();

  for (const run of runs) {
    const prompt = String(run?.prompt ?? "").trim();
    if (!prompt) continue;
    const category = String(run?.category ?? "uncategorized").trim() || "uncategorized";
    const key = `${category}\u0000${prompt}`;
    const row = groups.get(key) ?? {
      prompt,
      category,
      totalRuns: 0,
      validRuns: 0,
      mentionedRuns: 0,
      failedRuns: 0,
      citationValidRuns: 0,
      citationComparableRuns: 0,
      visibleCitations: 0,
    };

    row.totalRuns += 1;
    if (run?.status === "failed") row.failedRuns += 1;
    if (validObservedRun(run)) {
      row.validRuns += 1;
      if (run?.brand_mentioned === true) row.mentionedRuns += 1;
    }
    if (citationValidObservedRun(run)) {
      row.citationValidRuns += 1;
      const captured = numberOrNull(run?.captured_citation_count ?? run?.capturedCitationCount);
      if (captured != null && captured >= 0) {
        row.citationComparableRuns += 1;
        row.visibleCitations += captured;
      }
    }
    groups.set(key, row);
  }

  const rows = [...groups.values()].map((row) => {
    const mentionRate = row.validRuns > 0 ? row.mentionedRuns / row.validRuns : null;
    const citationEvidenceRate = row.validRuns > 0
      ? row.citationValidRuns / row.validRuns
      : null;
    const citationDensity = row.citationComparableRuns > 0
      ? row.visibleCitations / row.citationComparableRuns
      : null;
    const state = promptState({ ...row, mentionRate });
    return { ...row, mentionRate, citationEvidenceRate, citationDensity, ...state };
  });

  rows.sort((a, b) =>
    a.rank - b.rank ||
    b.validRuns - a.validRuns ||
    (a.mentionRate ?? 2) - (b.mentionRate ?? 2) ||
    a.prompt.localeCompare(b.prompt, "zh-CN"),
  );

  return {
    rows: rows.slice(0, Math.max(1, Number(maxRows) || 30)),
    totalPrompts: rows.length,
    observedRuns: runs.length,
    assignmentCount,
    truncated: Number.isFinite(assignmentCount) && assignmentCount > runs.length,
    stateCounts: rows.reduce((acc, row) => {
      acc[row.key] = (acc[row.key] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export function promptOpportunityBrowserBundle() {
  return [numberOrNull, validObservedRun, citationValidObservedRun, promptState, buildPromptOpportunities]
    .map((fn) => fn.toString())
    .join("\n");
}
