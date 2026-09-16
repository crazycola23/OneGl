import assert from "node:assert/strict";
import test from "node:test";

import { summarizeDoubaoSourceSignals } from "../src/analysis/doubao-source-signals.js";
import {
  MonitorPlanValidationError,
  nextScheduledAt,
  normalizeMonitorPlanInput,
} from "../src/monitoring/plans.js";

test("daily Doubao monitor schedules use Asia/Shanghai wall clock", () => {
  const before = nextScheduledAt(
    { cadence: "daily", timeZone: "Asia/Shanghai", localHour: 9, localMinute: 0 },
    new Date("2026-09-16T00:30:00Z"),
  );
  assert.equal(before.toISOString(), "2026-09-16T01:00:00.000Z");

  const after = nextScheduledAt(
    { cadence: "daily", timeZone: "Asia/Shanghai", localHour: 9, localMinute: 0 },
    new Date("2026-09-16T02:00:00Z"),
  );
  assert.equal(after.toISOString(), "2026-09-17T01:00:00.000Z");
});

test("weekly monitor keeps ISO weekday in project time zone", () => {
  const before = nextScheduledAt(
    { cadence: "weekly", timeZone: "Asia/Shanghai", localHour: 9, localMinute: 0, weekday: 3 },
    new Date("2026-09-16T00:30:00Z"),
  );
  assert.equal(before.toISOString(), "2026-09-16T01:00:00.000Z");

  const after = nextScheduledAt(
    { cadence: "weekly", timeZone: "Asia/Shanghai", localHour: 9, localMinute: 0, weekday: 3 },
    new Date("2026-09-16T02:00:00Z"),
  );
  assert.equal(after.toISOString(), "2026-09-23T01:00:00.000Z");
});

test("monitor plan input stays conservative and bounded", () => {
  const plan = normalizeMonitorPlanInput({
    name: "每日品牌监测",
    cadence: "daily",
    local_time: "09:30",
    accounts: ["a", "a", " b "],
    size: 20,
    repeats: 2,
  });
  assert.equal(plan.timeZone, "Asia/Shanghai");
  assert.equal(plan.localTime, "09:30");
  assert.deepEqual(plan.accounts, ["a", "b"]);
  assert.equal(plan.sampleSize, 20);
  assert.throws(
    () => normalizeMonitorPlanInput({ name: "bad", cadence: "hourly", accounts: ["a"] }),
    MonitorPlanValidationError,
  );
  assert.throws(
    () => normalizeMonitorPlanInput({ name: "bad", cadence: "daily", local_time: "25:00", accounts: ["a"] }),
    MonitorPlanValidationError,
  );
});

test("Doubao cited-page signals report observable patterns without causal claims", () => {
  const rows = [
    { fetch_state: "success", content_profile: { type: "guide" }, h2_count: 4, table_count: 1, list_count: 1, faq_heading_count: 0, author_present: true, published_at_raw: "2026-09-01", text_length: 3000, brand_mentioned: false },
    { fetch_state: "success", content_profile: { type: "guide" }, h2_count: 5, table_count: 1, list_count: 1, faq_heading_count: 1, author_present: true, published_at_raw: "2026-09-02", text_length: 3600, brand_mentioned: true },
    { fetch_state: "success", content_profile: { type: "review" }, h2_count: 3, table_count: 1, list_count: 0, faq_heading_count: 0, author_present: false, published_at_raw: null, text_length: 2400, brand_mentioned: false },
    { fetch_state: "failed", content_profile: {}, brand_mentioned: null },
    { fetch_state: "success", content_profile: { type: "guide" }, h2_count: 2, table_count: 1, list_count: 1, faq_heading_count: 0, author_present: true, published_at_raw: "2026-09-03", text_length: 2800, brand_mentioned: false },
    { fetch_state: "success", content_profile: { type: "review" }, h2_count: 2, table_count: 0, list_count: 1, faq_heading_count: 0, author_present: true, published_at_raw: "2026-09-04", text_length: 2600, brand_mentioned: false },
  ];
  const summary = summarizeDoubaoSourceSignals(rows);
  assert.equal(summary.citedPages, 6);
  assert.equal(summary.analyzedPages, 5);
  assert.equal(summary.brandEvidencePages, 1);
  assert.equal(summary.brandEvidenceRate, 0.2);
  assert.ok(summary.patterns.some((row) => row.trait === "二级标题"));
  assert.ok(summary.opportunities.some((row) => row.category === "cited-page-brand-evidence"));
  assert.match(summary.attributionNote, /不把.*相关性.*豆包内部排序|不把这些相关性/);
});
