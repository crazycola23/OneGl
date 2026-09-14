import assert from "node:assert/strict";
import test from "node:test";

import {
  benjaminiHochberg,
  buildCitationFactorReportFromRows,
  twoProportionPValue,
} from "../src/analysis/citation-factor-report.js";

test("two-proportion evidence is stronger for a large rate separation", () => {
  const strong = twoProportionPValue(30, 60, 10, 60);
  const weak = twoProportionPValue(14, 60, 10, 60);
  assert.ok(strong < weak);
  assert.ok(strong < 0.01);
});

test("Benjamini-Hochberg keeps missing values missing and preserves ordered evidence", () => {
  const q = benjaminiHochberg([0.001, null, 0.01, 0.03, 0.4]);
  assert.equal(q.length, 5);
  assert.equal(q[1], null);
  const observed = [q[0], q[2], q[3], q[4]];
  assert.ok(observed.every((value) => value >= 0 && value <= 1));
  assert.ok(observed[0] <= observed[1]);
  assert.ok(observed[1] <= observed[2]);
  assert.ok(observed[2] <= observed[3]);
});

test("factor report annotates non-missing buckets with FDR q-values and evidence levels", () => {
  const rows = [];
  for (let index = 0; index < 120; index += 1) {
    const hasTable = index < 60;
    const cited = hasTable ? index < 30 : index >= 60 && index < 70;
    rows.push({
      run_id: Math.floor(index / 3) + 1,
      article_id: index + 1,
      cited,
      source_position: (index % 8) + 1,
      source_name: "source",
      title: `新能源 SUV 报告 ${index}`,
      summary: "价格 续航 配置 对比",
      prompt: "新能源 SUV 怎么选",
      search_query_count: 2,
      article_retrievals: 1,
      queries: ["新能源 SUV 推荐", "新能源 SUV 续航"],
      page_evidence_state: "success",
      page_text_length: 5000,
      page_h2_count: 4,
      page_table_count: hasTable ? 1 : 0,
      page_list_count: 1,
      page_faq_heading_count: 0,
      page_external_link_count: 3,
      page_has_article_schema: true,
      page_has_faq_schema: false,
      page_author_present: true,
      page_modified_at_raw: "2026-09-10",
      page_robots_noindex: false,
      page_numeric_density: 8,
    });
  }

  const report = buildCitationFactorReportFromRows(rows, {
    batchId: 9,
    minN: 10,
    signalMinN: 20,
  });
  const tableYes = report.factors.find(
    (row) => row.factor === "page_table_present" && row.bucket === "yes",
  );
  assert.ok(tableYes);
  assert.ok(Number.isFinite(tableYes.qValue));
  assert.ok(tableYes.qValue <= 0.1);
  assert.match(tableYes.evidenceLevel, /较强|中等/);
  assert.ok(report.strongestSignals.some((row) => row.factor === "page_table_present"));
  assert.match(report.semantics.multipleTesting, /Benjamini-Hochberg/);
});
