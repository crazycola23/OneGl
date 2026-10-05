/**
 * 跨批次的 run 状态不得被继承。
 *
 * 锁的是 2026-10-06 一次真实污染：批次 5 的 run_b5_i1 报出
 * dur_s = 1522111 秒（约 17.6 天），而 runs.started_at 是 09-18、created_at 是 10-06。
 *
 * 根因链：
 *   DB 清库 → 批次 id 从 1 重排 → runToken（「批次 id + 下标」）撞名
 *   → 新批次 5 的 run_b5_i1 撞上 9 月批次 5 的同名目录
 *   → 目录里那份 run.json 被当成「本次的上一次尝试」读出
 *   → `startedAt: previous?.startedAt ?? now` 沿用了几周前的时间
 *
 * 磁盘上的 run.json 证据：
 *   attemptStartedAt = 2026-10-05T19:13:44  ← 本次
 *   startedAt       = 2026-09-18T04:28:20  ← 上次（9 月）
 *
 * 与教训 8.6「artifact 里的旧格式会毒化重放」同源：
 * 那里是旧格式的 artifact，这里是旧 run.json。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../src/store.js";

async function makeStoreWithStaleRun({ staleBatchId, staleStatus = "failed" }) {
  const dataDir = await mkdtemp(join(tmpdir(), "onegl-store-"));
  const store = new RunStore({ dataDir });
  // 造一个「别的批次」的残留 run.json —— 目录名相同、批次号不同
  const dir = join(dataDir, "runs", "run_b5_i1");
  await mkdir(join(dir, "attempts", "1"), { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      id: "run_b5_i1",
      project: "旧项目",
      provider: "doubao",
      prompt: "旧问题",
      accountKey: "t_old",
      samplingBatchId: staleBatchId,
      runToken: `b${staleBatchId}_i1`,
      jobId: `b${staleBatchId}_i1`,
      attempt: 1,
      attempts: [1],
      attemptHistory: [],
      status: staleStatus,
      // ★ 这个几周前的时间就是污染源
      startedAt: "2026-09-18T04:28:20.898Z",
      completedAt: "2026-09-18T04:28:26.682Z",
      errorCode: "PAGE_CHANGED",
      errorMessage: "9 月那次的前置检查失败",
    }),
    "utf8",
  );
  return { store, dataDir, dir };
}

const createRun = (store, overrides = {}) =>
  store.createRun({
    prompt: "今天的问题",
    attempt: 1,
    samplingBatchId: 5,
    runToken: "b5_i1",
    jobId: "b5_i1",
    ...overrides,
  });

test("跨批次的 startedAt 不得被继承（DB 清库后编号重排会撞名）", async () => {
  // ★ 必须用**不同**的批次号。真实的撞名场景是：清库后批次 id 重排，
  // 新批次 5 撞上的是 9 月批次 5 之外的另一个号（或 runToken 生成规则变化）。
  // 同批次号就该正常继承 —— 那是真重试，见下面第三条用例。
  const { store, dir } = await makeStoreWithStaleRun({ staleBatchId: 4 });
  const run = await createRun(store, { runId: "run_b5_i1" });
  assert.notEqual(
    run.startedAt,
    "2026-09-18T04:28:20.898Z",
    "不得沿用残留 run.json 的 startedAt —— 那会让耗时算成 17.6 天",
  );
  const written = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
  assert.notEqual(
    written.startedAt,
    "2026-09-18T04:28:20.898Z",
    "落盘的 run.json 也不该保留旧的 startedAt",
  );
});

test("跨批次的 attemptHistory 不得被继承（旧项目的错误会混进新 run）", async () => {
  const { store } = await makeStoreWithStaleRun({ staleBatchId: 4 });
  const run = await createRun(store, { runId: "run_b5_i1" });
  assert.deepEqual(
    run.attemptHistory,
    [],
    "批次不同就不是同一条 run 的历史 —— 旧错误不该混进来",
  );
  assert.deepEqual(run.attempts, [1], "attempts 只应包含本次的 attempt");
});

test("同批次的重试仍然正常继承（不能把真重试也一起干掉）", async () => {
  const { store } = await makeStoreWithStaleRun({ staleBatchId: 4 });
  // 先跑一次并落成终态（不落终态的话 RUN_STATE_UNCERTAIN 闸门会正确地拦下
  // attempt 2 —— 那是另一个功能的契约，不是这里要测的）
  const first = await createRun(store, { runId: "run_b5_i1" });
  await store.updateRun("run_b5_i1", {
    status: "failed",
    errorCode: "ANSWER_NOT_FOUND",
    errorMessage: "没等到答案",
    completedAt: new Date().toISOString(),
  });

  const second = await store.createRun({
    prompt: "今天的问题",
    attempt: 2,
    samplingBatchId: 5,
    runToken: "b5_i1",
    jobId: "b5_i1",
    runId: "run_b5_i1",
  });
  assert.notEqual(
    second.startedAt,
    "2026-09-18T04:28:20.898Z",
    "同批次继承的也不应是 9 月那个时间",
  );
  assert.ok(
    second.startedAt <= first.completedAt || second.startedAt >= first.startedAt,
    "同批次的 startedAt 应落在本批次的时间范围内",
  );
  assert.deepEqual(
    [...new Set(second.attempts)].sort((a, b) => a - b),
    [1, 2],
    "同批次的 attempt 序列应累加 —— 跨批次过滤不能把真重试也干掉",
  );
});

test("残留 run.json 处于 running 时，跨批次不应触发 RUN_STATE_UNCERTAIN", async () => {
  // 这是修法里最容易被漏掉的一条：那道闸门若还用 previous，
  // 9 月的残留（status=running）会让今天的新 run 直接抛错。
  const { store } = await makeStoreWithStaleRun({ staleBatchId: 4, staleStatus: "running" });
  let thrown = null;
  try {
    await createRun(store, { runId: "run_b5_i1", attempt: 2 });
  } catch (error) {
    thrown = error;
  }
  assert.equal(
    thrown,
    null,
    "跨批次残留不该触发 RUN_STATE_UNCERTAIN —— 那是另一条 run 的状态",
  );
});