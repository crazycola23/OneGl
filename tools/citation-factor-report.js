import "dotenv/config";
import {
  FACTOR_LABELS,
  loadCitationFactorReport,
} from "../src/analysis/citation-factor-report.js";
import { createPool } from "../src/db/pool.js";

const pool = createPool();

function pct(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function signedPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a";
  const number = Number(value) * 100;
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function parseArgs(argv) {
  const args = { batchId: null, minN: 10, signalMinN: 20, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--batch") args.batchId = Number(argv[++index]);
    else if (value === "--min-n") args.minN = Number(argv[++index]);
    else if (value === "--signal-min-n") args.signalMinN = Number(argv[++index]);
    else if (value === "--json") args.json = true;
    else if (!value.startsWith("--") && args.batchId == null) args.batchId = Number(value);
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!Number.isInteger(args.batchId) || args.batchId <= 0) {
    throw new Error("Usage: npm run report:factors -- --batch <positive batch id> [--min-n 10] [--signal-min-n 20] [--json]");
  }
  if (!Number.isInteger(args.minN) || args.minN <= 0) throw new Error("--min-n must be a positive integer");
  if (!Number.isInteger(args.signalMinN) || args.signalMinN <= 0) throw new Error("--signal-min-n must be a positive integer");
  return args;
}

function printReport(report) {
  const { cohort } = report;
  console.log(`\n=== Citation Factor Analysis / Batch ${report.batchId} ===`);
  console.table([{
    干净运行: cohort.runs,
    候选来源: cohort.candidates,
    最终引用命中: cohort.cited,
    基线转化率: pct(cohort.baselineRate),
  }]);

  if (!cohort.candidates) {
    console.log("没有可分析的候选来源。请先启用 Network evidence 并采集成功批次。");
    return;
  }

  const coverage = report.matchCoverage;
  if (coverage) {
    console.log("\n=== 匹配覆盖（先看这个，再看任何转化率） ===");
    console.table([{
      候选数: coverage.candidates,
      精确命中: coverage.exact,
      别名命中: coverage.alias,
      未匹配: coverage.unmatched,
      未匹配占比: pct(coverage.unmatchedShare),
      涉及域名: coverage.domains,
    }]);
  }

  const gate = report.evidenceGate;
  if (gate) {
    console.log(`\n=== 证据门槛：${gate.label} (${gate.status}) ===`);
    for (const item of gate.blockers) console.log(`  ✖ [${item.code}] ${item.message}`);
    for (const item of gate.warnings) console.log(`  ⚠ [${item.code}] ${item.message}`);
    if (!gate.allowOptimizationAdvice) {
      console.log("  → 本批次不输出优化建议；下面的最强信号仅作诊断，不能作为行动依据。");
    }
    console.log("");
  }

  if (report.design) {
    console.log(
      `观察单位：${cohort.candidates} 条候选来自 ${report.design.domainCount} 个域名，` +
        `平均每域名 ${report.design.meanClusterSize} 条 → 有效样本量约 ${report.design.nEff}。` +
        "（候选行不是相互独立的观察，同域名页面共享平台看不见的站点特征。）\n",
    );
  }

  console.log("口径：只分析 success + 已确认新会话 + network evidence=found 的运行；partial/failed 不进入因子分析。");
  console.log(`页面证据：${report.pageEvidence.successfulArticles}/${report.pageEvidence.totalArticles} 篇唯一候选文章抓取成功（${pct(report.pageEvidence.successRate)}）。页面特征只对抓取成功样本有效。\n`);

  const grouped = new Map();
  for (const row of report.factors) {
    const items = grouped.get(row.factor) ?? [];
    items.push(row);
    grouped.set(row.factor, items);
  }

  for (const [factor, rows] of grouped) {
    console.log(`=== ${FACTOR_LABELS[factor] ?? factor} ===`);
    console.table(rows.map((row) => ({
      分组: row.bucket,
      样本: row.candidates,
      域名数: row.domains ?? "—",
      可配对域名: row.pairedDomains ?? 0,
      命中: row.cited,
      引用率: pct(row.rate),
      相对基线: signedPct(row.uplift),
      "域内差值": signedPct(row.withinDomainDifference),
      "FDR q": pct(row.qValue),
      方向一致: row.directionConsistent ? "是" : "否",
      检验口径: row.significanceBasis ?? "—",
      证据等级: row.evidenceLevel,
    })));
  }

  if (report.suppressedSignals?.length) {
    console.log("=== 被证据门槛抑制的信号（仅诊断，不得作为行动依据） ===");
    console.table(report.suppressedSignals.map((row) => ({
      因子: row.factorLabel ?? FACTOR_LABELS[row.factor] ?? row.factor,
      分组: row.bucket,
      样本: row.candidates,
      域名数: row.domains ?? "—",
      域内差值: signedPct(row.withinDomainDifference),
      "FDR q": pct(row.qValue),
      证据等级: row.evidenceLevel,
    })));
  }

  if (report.strongestSignals.length) {
    console.log("=== 关联幅度最大的分组（达到最低样本门槛；missing 不参与） ===");
    console.table(report.strongestSignals.map((row) => ({
      因子: row.factorLabel ?? FACTOR_LABELS[row.factor] ?? row.factor,
      分组: row.bucket,
      样本: row.candidates,
      引用率: pct(row.rate),
      相对基线: signedPct(row.uplift),
      "FDR q": pct(row.qValue),
      证据等级: row.evidenceLevel,
    })));
  }

  if (report.domains.length) {
    console.log("=== 候选量最高的域名（描述性，不控制混杂因素） ===");
    console.table(report.domains.map((row) => ({
      域名: row.domain,
      候选: row.candidates,
      最终引用: row.cited,
      引用率: pct(row.rate),
      "95%区间": `${pct(row.ciLow)} ~ ${pct(row.ciHigh)}`,
      文章数: row.articles,
      运行数: row.runs,
    })));
  }

  console.log(
    "\n注意：uplift 是观察到的相关性，不等于因果影响，也不是豆包内部权重。" +
      "主检验口径是「域内配对」（Wilcoxon signed-rank，对每个域名比较该分组与其同域对照），" +
      "再做 Benjamini-Hochberg FDR 校正；pValueNaive 的合并口径只作参考。" +
      "页面特征来自 OneGl 自己的公开 HTTP 抓取快照，可能与豆包当时看到的版本不同。\n",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await loadCitationFactorReport(pool, options.batchId, {
    minN: options.minN,
    signalMinN: options.signalMinN,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
