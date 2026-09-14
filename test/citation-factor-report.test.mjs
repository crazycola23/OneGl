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

function candidateRow(index, { domain, hasTable, cited }) {
  return {
    run_id: Math.floor(index / 3) + 1,
    article_id: index + 1,
    cited,
    domain,
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
  };
}

/**
 * A genuine within-domain effect: in every domain the pages that have a table get cited
 * more often and the pages that do not get cited less often. The pooled rate and the
 * within-domain rate agree, which is the case where a recommendation is allowed.
 */
function consistentRows(perDomain = 6) {
  const rows = [];
  let index = 0;
  // Every domain contains both arms (so it can be paired inside itself) and every
  // domain shows the same direction.
  const yesCited = Math.max(1, Math.round(perDomain * 0.8));
  const noCited = Math.max(0, Math.round(perDomain * 0.2));
  for (let domain = 1; domain <= 6; domain += 1) {
    for (let i = 0; i < perDomain; i += 1) rows.push(candidateRow(index++, { domain: `site${domain}.example`, hasTable: true, cited: i < yesCited }));
    for (let i = 0; i < perDomain; i += 1) rows.push(candidateRow(index++, { domain: `site${domain}.example`, hasTable: false, cited: i < noCited }));
  }
  return rows;
}

/**
 * Simpson's paradox: pages with a table really are cited more often when you pool every
 * candidate, but inside each domain the table pages are the *less* cited ones. A pooled
 * p-value calls this a strong signal; the within-domain test correctly refuses.
 */

test("a within-domain consistent effect keeps its evidence level and stays in strongestSignals", () => {
  const report = buildCitationFactorReportFromRows(consistentRows(18), {
    batchId: 9,
    minN: 10,
    signalMinN: 20,
    matchCoverage: { candidates: 216, exact: 200, alias: 12, unmatched: 4, observedShare: 0.98 },
  });
  const tableYes = report.factors.find(
    (row) => row.factor === "page_table_present" && row.bucket === "yes",
  );
  assert.ok(tableYes);
  assert.equal(tableYes.significanceBasis, "paired_within_domain");
  assert.ok(tableYes.pairedDomains >= 3);
  assert.equal(tableYes.directionConsistent, true);
  assert.ok(Number.isFinite(tableYes.qValue));
  assert.ok(tableYes.qValue <= 0.1);
  assert.match(tableYes.evidenceLevel, /较强|中等/);
  assert.ok(report.strongestSignals.some((row) => row.factor === "page_table_present"));
  assert.match(report.semantics.multipleTesting, /Benjamini-Hochberg/);
});
function oneSidedPerDomainRows() {
  const rows = [];
  let index = 0;
  // Sites that use tables are the sites that get cited; the sites that do not use tables
  // are rarely cited at all. Pooled, that reads as "tables get cited more often" - and
  // there is no way to check it, because no single site contains both arms.
  const tableSites = 10;
  const plainSites = 6;
  for (let domain = 1; domain <= tableSites + plainSites; domain += 1) {
    const usesTable = domain <= tableSites;
    for (let i = 0; i < 8; i += 1) {
      rows.push(candidateRow(index++, { domain: `site${domain}.example`, hasTable: usesTable, cited: usesTable ? i < 7 : i < 1 }));
    }
  }
  return rows;
}
/**
 * The unanswerable case: each domain contributed only one arm, so no domain can be
 * compared against itself. The pooled difference is real arithmetic but says nothing
 * about the factor.
 */
test("a one-sided design can only ever be exploratory, however large the pooled gap", () => {
  const report = buildCitationFactorReportFromRows(oneSidedPerDomainRows(), {
    batchId: 9,
    minN: 10,
    signalMinN: 20,
    matchCoverage: { candidates: 128, exact: 110, alias: 8, unmatched: 10, observedShare: 0.92 },
  });
  const tableYes = report.factors.find(
    (row) => row.factor === "page_table_present" && row.bucket === "yes",
  );
  assert.ok(tableYes);

  // The pooled view reports a large, confident difference...
  assert.ok(tableYes.pooledUplift > 0.1);
  assert.ok(tableYes.pValueNaive < 0.01);
  // ...that no domain can verify, because no domain contributed both arms. That is a
  // statement about which sites use tables, not about tables.
  assert.equal(tableYes.pairedDomains, 0);
  assert.equal(tableYes.significanceBasis, "pooled_naive");
  assert.ok(!/^较强$|^中等$/.test(tableYes.evidenceLevel));
});

test("with complete pairs the pooled effect can never disagree with the within-domain effect", () => {
  // Regression guard for the algebra: because the pooled difference is proportional to
  // the within-domain difference when every domain contributes both arms, a sign flip is
  // impossible by construction. If this ever fails, the stratified aggregation has been
  // changed in a way that breaks the pairing.
  const report = buildCitationFactorReportFromRows(oneSidedPerDomainRows(), {
    batchId: 9,
    minN: 10,
    signalMinN: 20,
    matchCoverage: { candidates: 128, exact: 110, alias: 8, unmatched: 10, observedShare: 0.92 },
  });
  const tableYes = report.factors.find(
    (row) => row.factor === "page_table_present" && row.bucket === "yes",
  );
  assert.equal(tableYes.pooledWithinDisagree, undefined);
  assert.equal(tableYes.withinDomainDifference, null);
});
test("the evidence gate suppresses recommendations when coverage or sample is too low", () => {
  const report = buildCitationFactorReportFromRows(oneSidedPerDomainRows(), {
    batchId: 9,
    minN: 10,
    signalMinN: 20,
    matchCoverage: { candidates: 128, exact: 30, alias: 8, unmatched: 90, observedShare: 0.30 },
  });
  assert.equal(report.evidenceGate.allowOptimizationAdvice, false);
  assert.equal(report.evidenceGate.status, "insufficient");
  assert.ok(report.evidenceGate.blockers.some((item) => item.code === "MATCH_COVERAGE_LOW"));
  assert.equal(report.strongestSignals.length, 0);
  assert.ok(report.suppressedSignals.length > 0);
  assert.ok(report.design.nEff < report.cohort.candidates);
});
