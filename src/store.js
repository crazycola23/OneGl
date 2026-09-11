import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function safeTimestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export class RunStore {
  constructor(config) {
    this.dataDir = config.dataDir;
    this.runsDir = path.join(config.dataDir, "runs");
  }

  async init() {
    await mkdir(this.runsDir, { recursive: true });
  }

  runDir(runId) {
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      throw new Error("Invalid run id");
    }
    return path.join(this.runsDir, runId);
  }

  runFile(runId) {
    return path.join(this.runDir(runId), "run.json");
  }

  async createRun({
    prompt,
    project = "default",
    accountKey = null,
    samplingBatchId = null,
    runToken = null,
    jobId = null,
    runId: explicitRunId = null,
  }) {
    await this.init();
    // 批次任务使用确定性 id，队列重试时复用同一个目录与同一条记录，
    // 因此不会产生重复 Run。
    const runId = explicitRunId ?? `run_${safeTimestamp()}_${randomUUID().slice(0, 8)}`;
    await mkdir(this.runDir(runId), { recursive: false }).catch(() => undefined);
    const run = {
      id: runId,
      project,
      provider: "doubao",
      prompt,
      accountKey,
      samplingBatchId,
      runToken,
      jobId,
      attempt: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      answer: null,
      citationState: null,
      expectedCitationCount: null,
      citations: [],
      // Whether this run provably started from an empty conversation. Only confirmed
      // runs belong in the headline mention-rate statistic.
      conversationResetConfirmed: null,
      // Brand detection result, kept alongside the raw answer for audit.
      brandMentioned: null,
      mentionCount: null,
      firstMentionPosition: null,
      matchedTerms: [],
      brandDetectionVersion: null,
      errorCode: null,
      errorMessage: null,
      errorDetails: null,
      currentUrl: null,
      debugPath: path.relative(process.cwd(), this.runDir(runId)),
    };
    await this.writeRun(run);
    return run;
  }

  async writeRun(run) {
    const target = this.runFile(run.id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  async updateRun(runId, patch) {
    const current = await this.readRun(runId);
    const next = { ...current, ...patch };
    await this.writeRun(next);
    return next;
  }

  async writeArtifact(runId, name, data) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error("Invalid artifact name");
    }
    const target = path.join(this.runDir(runId), name);
    await writeFile(target, data);
    return target;
  }

  async readRun(runId) {
    const raw = await readFile(this.runFile(runId), "utf8");
    return JSON.parse(raw);
  }

  async listRuns() {
    await this.init();
    const names = await readdir(this.runsDir);
    const runs = [];
    for (const name of names) {
      if (!name.startsWith("run_")) continue;
      const file = path.join(this.runsDir, name, "run.json");
      if (!(await exists(file))) continue;
      try {
        runs.push(JSON.parse(await readFile(file, "utf8")));
      } catch {
        // Keep one corrupt run from hiding all healthy runs.
      }
    }
    return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  async aggregateSources() {
    const runs = await this.listRuns();
    const byUrl = new Map();
    const byDomain = new Map();

    for (const run of runs) {
      for (const citation of run.citations || []) {
        const key = citation.canonicalUrl || citation.url;
        const current = byUrl.get(key) || {
          canonicalUrl: key,
          title: citation.title || null,
          domain: citation.domain || null,
          count: 0,
          runIds: [],
        };
        current.count += 1;
        if (!current.runIds.includes(run.id)) current.runIds.push(run.id);
        if (!current.title && citation.title) current.title = citation.title;
        byUrl.set(key, current);

        const domain = citation.domain || "unknown";
        byDomain.set(domain, (byDomain.get(domain) || 0) + 1);
      }
    }

    return {
      totalRuns: runs.length,
      totalCitations: [...byUrl.values()].reduce((sum, item) => sum + item.count, 0),
      topDomains: [...byDomain.entries()]
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count),
      topArticles: [...byUrl.values()].sort((a, b) => b.count - a.count),
    };
  }
}
