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

  /** 单次尝试的产物目录：attempts/<n>/，不同 attempt 的现场互不覆盖。 */
  attemptDir(runId, attempt) {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error(`Invalid attempt: ${JSON.stringify(attempt)}`);
    }
    return path.join(this.runDir(runId), "attempts", String(attempt));
  }

  /** 产物目录的仓库相对路径，用于写进 run.json 与数据库。 */
  attemptPath(runId, attempt) {
    return path.relative(process.cwd(), this.attemptDir(runId, attempt));
  }

  async createRun({
    prompt,
    project = "default",
    accountKey = null,
    samplingBatchId = null,
    runToken = null,
    jobId = null,
    attempt = 1,
    runId: explicitRunId = null,
  }) {
    await this.init();
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error(`attempt must be a positive integer, received ${JSON.stringify(attempt)}`);
    }

    const runId = explicitRunId ?? `run_${safeTimestamp()}_${randomUUID().slice(0, 8)}`;
    await mkdir(this.runDir(runId), { recursive: true });

    const previous = await this.readRun(runId).catch(() => null);
    const deterministicBatchRun =
      previous?.samplingBatchId != null || String(previous?.runToken ?? "").startsWith("batch:");

    // A deterministic batch run that is still marked running after the worker moved on to
    // a later attempt has an unknowable provider-submission boundary: the old process may
    // have died immediately after sending the prompt. Never overwrite that evidence and
    // resubmit automatically. A settled failed run remains retryable through the normal
    // promptSubmitted=false gate, while a completed run is handled by persist-only replay.
    // Generic/local RunStore callers without batch identity can still reuse one explicit run
    // directory across attempts; the provider exactly-once boundary is a batch-worker rule.
    if (
      explicitRunId &&
      deterministicBatchRun &&
      previous?.status === "running" &&
      Number.isInteger(previous.attempt) &&
      attempt > previous.attempt
    ) {
      const error = new Error(
        `Run ${runId} attempt ${previous.attempt} did not settle; refusing automatic attempt ${attempt} because provider submission state is uncertain`,
      );
      error.code = "RUN_STATE_UNCERTAIN";
      error.details = {
        runId,
        previousAttempt: previous.attempt,
        requestedAttempt: attempt,
      };
      throw error;
    }

    const attempts = [...new Set([...(previous?.attempts ?? []), attempt])].sort(
      (a, b) => a - b,
    );

    const settled = previous && previous.status && previous.status !== "running";
    const previousHistory = settled
      ? [
          {
            attempt: previous.attempt,
            status: previous.status,
            errorCode: previous.errorCode ?? null,
            errorMessage: previous.errorMessage ?? null,
            finishedAt: previous.completedAt ?? null,
            artifactPath: previous.artifactPath ?? null,
          },
        ]
      : [];
    const attemptHistory = [...(previous?.attemptHistory ?? []), ...previousHistory].filter(
      (entry, index, list) => list.findIndex((item) => item.attempt === entry.attempt) === index,
    );

    const run = {
      id: runId,
      project,
      provider: "doubao",
      prompt,
      accountKey,
      samplingBatchId,
      runToken,
      jobId,
      attempt,
      attempts,
      attemptHistory,
      status: "running",
      attemptStartedAt: new Date().toISOString(),
      startedAt: previous?.startedAt ?? new Date().toISOString(),
      completedAt: null,
      answer: null,
      citationState: null,
      expectedCitationCount: null,
      citations: [],
      conversationResetConfirmed: null,
      brandMentioned: null,
      mentionCount: null,
      firstMentionPosition: null,
      matchedTerms: [],
      brandDetectionVersion: null,
      errorCode: null,
      errorMessage: null,
      errorDetails: null,
      currentUrl: null,
      artifactPath: this.attemptPath(runId, attempt),
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

  /**
   * 列出这个 Run 在磁盘上真实存在的 attempt 目录与文件。
   * 界面用它给出调试产物链接，而不是靠推测路径。
   */
  async listAttemptArtifacts(runId) {
    const attemptsRoot = path.join(this.runDir(runId), "attempts");
    let names = [];
    try {
      names = await readdir(attemptsRoot);
    } catch {
      return [];
    }

    const result = [];
    for (const name of names.sort((a, b) => Number(a) - Number(b))) {
      const attempt = Number(name);
      if (!Number.isInteger(attempt)) continue;
      const dir = path.join(attemptsRoot, name);
      let files = [];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      result.push({
        attempt,
        dir: path.relative(process.cwd(), dir),
        files: files.sort(),
      });
    }
    return result;
  }

  /**
   * 把 URL 片段解析成运行目录内的绝对路径。
   *
   * 这是 Web 端读取本地产物的唯一安全边界：任何非法片段、目录穿越、层数不符都返回 null，
   * 因此它必须足够简单、并且可以被离线测试直接覆盖。
   *
   * 允许的形状：
   *   screenshot.png
   *   attempts/1/screenshot.png
   */
  resolveArtifact(runId, segments) {
    let base;
    try {
      base = path.resolve(this.runDir(runId));
    } catch {
      return null;
    }

    if (!Array.isArray(segments) || segments.length === 0 || segments.length > 3) return null;
    for (const segment of segments) {
      if (typeof segment !== "string" || !/^[A-Za-z0-9._-]+$/.test(segment)) return null;
    }

    if (segments[0] === "attempts") {
      if (segments.length !== 3 || !/^\d+$/.test(segments[1])) return null;
    } else if (segments.length !== 1) {
      return null;
    }

    const target = path.resolve(base, ...segments);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) return null;
    return target;
  }

  /**
   * 列出运行根目录下的产物文件。
   * 用于兼容 attempts/<n>/ 之前的旧布局，让历史 Run 也能在界面上拿到调试产物。
   */
  async listRootArtifacts(runId) {
    let names = [];
    try {
      names = await readdir(this.runDir(runId));
    } catch {
      return [];
    }
    return names
      .filter((name) => name !== "attempts" && /^[A-Za-z0-9._-]+$/.test(name))
      .sort();
  }

  async writeAttemptArtifact(runId, attempt, name, data) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error("Invalid artifact name");
    }
    const dir = this.attemptDir(runId, attempt);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
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
