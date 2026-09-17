import assert from "node:assert/strict";
import test from "node:test";

import { buildPromptOpportunities } from "../src/report/prompt-opportunities.js";

function run(prompt, overrides = {}) {
  return {
    prompt,
    category: "科普",
    status: "success",
    conversation_reset_confirmed: true,
    brand_mentioned: false,
    citation_state: "found",
    captured_citation_count: 2,
    ...overrides,
  };
}

test("Prompt 机会按数据缺口、未提及、低频、不稳定、稳定分层", () => {
  const detail = {
    report: { runs: { assignmentsRun: 9 } },
    runs: [
      run("无有效数据", { status: "failed", conversation_reset_confirmed: false }),
      run("从未提及"),
      run("从未提及"),
      run("低频提及", { brand_mentioned: true }),
      run("低频提及", { brand_mentioned: false }),
      run("低频提及", { brand_mentioned: false }),
      run("不稳定提及", { brand_mentioned: true }),
      run("不稳定提及", { brand_mentioned: false }),
      run("稳定提及", { brand_mentioned: true }),
    ],
  };

  const result = buildPromptOpportunities(detail);
  const byPrompt = Object.fromEntries(result.rows.map((row) => [row.prompt, row]));

  assert.equal(byPrompt["无有效数据"].key, "DATA_GAP");
  assert.equal(byPrompt["从未提及"].key, "NO_MENTION");
  assert.equal(byPrompt["低频提及"].key, "WEAK_MENTION");
  assert.equal(byPrompt["不稳定提及"].key, "UNSTABLE_MENTION");
  assert.equal(byPrompt["稳定提及"].key, "STABLE_MENTION");
  assert.equal(byPrompt["从未提及"].mentionRate, 0);
  assert.equal(byPrompt["稳定提及"].mentionRate, 1);
});

test("引用数据缺失保持 N/A 语义，不自动记成 0 引用", () => {
  const detail = {
    report: { runs: { assignmentsRun: 1 } },
    runs: [run("引用未知", { captured_citation_count: null })],
  };
  const [row] = buildPromptOpportunities(detail).rows;
  assert.equal(row.citationValidRuns, 1);
  assert.equal(row.citationComparableRuns, 0);
  assert.equal(row.citationEvidenceRate, 1);
  assert.equal(row.citationDensity, null);
});

test("旧快照 success Run 缺 citation_state 时仍可用 captured count 兼容", () => {
  const detail = {
    report: { runs: { assignmentsRun: 1 } },
    runs: [run("旧快照", { citation_state: null, captured_citation_count: 3 })],
  };
  const [row] = buildPromptOpportunities(detail).rows;
  assert.equal(row.citationValidRuns, 1);
  assert.equal(row.citationComparableRuns, 1);
  assert.equal(row.citationEvidenceRate, 1);
  assert.equal(row.citationDensity, 3);
});

test("partial citation parse failure 只参与品牌回答口径，不污染 Prompt 引用密度", () => {
  const detail = {
    report: { runs: { assignmentsRun: 2 } },
    runs: [
      run("同一问题", { brand_mentioned: true, captured_citation_count: 2 }),
      run("同一问题", {
        status: "partial",
        citation_state: "parse_failed",
        brand_mentioned: true,
        captured_citation_count: 20,
      }),
    ],
  };

  const [row] = buildPromptOpportunities(detail).rows;
  assert.equal(row.validRuns, 2);
  assert.equal(row.mentionedRuns, 2);
  assert.equal(row.mentionRate, 1);
  assert.equal(row.citationValidRuns, 1);
  assert.equal(row.citationComparableRuns, 1);
  assert.equal(row.citationEvidenceRate, 0.5);
  assert.equal(row.visibleCitations, 2);
  assert.equal(row.citationDensity, 2);
  assert.match(row.action, /引用证据覆盖 50\.0%/);
  assert.match(row.action, /不要把引用密度变化解释成业务变化/);
});

test("none_visible 是 citation-valid 的 0 引用证据", () => {
  const detail = {
    report: { runs: { assignmentsRun: 1 } },
    runs: [run("明确无引用", { citation_state: "none_visible", captured_citation_count: 0 })],
  };
  const [row] = buildPromptOpportunities(detail).rows;
  assert.equal(row.citationValidRuns, 1);
  assert.equal(row.citationComparableRuns, 1);
  assert.equal(row.citationEvidenceRate, 1);
  assert.equal(row.citationDensity, 0);
});

test("批次 API 只返回部分 Run 时明确标记 opportunity 表不完整", () => {
  const detail = {
    report: { runs: { assignmentsRun: 800 } },
    runs: [run("问题 A"), run("问题 B")],
  };
  const result = buildPromptOpportunities(detail);
  assert.equal(result.truncated, true);
  assert.equal(result.observedRuns, 2);
  assert.equal(result.assignmentCount, 800);
});

test("机会排序优先数据问题和 0 提及，而不是被引用总量带偏", () => {
  const detail = {
    report: { runs: { assignmentsRun: 4 } },
    runs: [
      run("稳定问题", { brand_mentioned: true, captured_citation_count: 0 }),
      run("零提及高引用", { brand_mentioned: false, captured_citation_count: 20 }),
      run("数据坏", { status: "failed", conversation_reset_confirmed: false, captured_citation_count: null }),
      run("半稳定", { brand_mentioned: true, captured_citation_count: 1 }),
    ],
  };
  const result = buildPromptOpportunities(detail);
  assert.equal(result.rows[0].prompt, "数据坏");
  assert.equal(result.rows[1].prompt, "零提及高引用");
  assert.match(result.rows[1].action, /实体覆盖|内容缺口/);
});
