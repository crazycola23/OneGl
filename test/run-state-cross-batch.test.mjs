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

async function makeStoreWithStaleRun({
  staleBatchId,
  staleStatus = "failed",
  staleProject = "旧项目",
  staleAccount = "t1_new",
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "onegl-store-"));
  const store = new RunStore({ dataDir });
  // 造一个「别的批次」的残留 run.json —— 目录名相同、批次号可能相同
  const dir = join(dataDir, "runs", "run_b5_i1");
  await mkdir(join(dir, "attempts", "1"), { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      id: "run_b5_i1",
      project: staleProject,
      provider: "doubao",
      prompt: "旧问题",
      accountKey: staleAccount,
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
    project: "probe-真实引用验证r6",
    accountKey: "t1_new",
    attempt: 1,
    samplingBatchId: 6,
    runToken: "b6_i1",
    jobId: "b6_i1",
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
  // ★ 残留那份必须**同批次、同项目、同账号**，才谈得上「真重试」。
  // 用 staleBatchId: 4 会让第一次调用就被判成跨批次而丢弃继承，
  // 于是第二次拿不到 [1,2] —— 那是测试场景写错，不是实现错。
  const { store } = await makeStoreWithStaleRun({
    staleBatchId: 6,
    staleProject: "probe-真实引用验证r6",
    staleAccount: "t1_new",
  });
  // 先跑一次并落成终态（不落终态的话 RUN_STATE_UNCERTAIN 闸门会正确地拦下
  // attempt 2 —— 那是另一个功能的契约，不是这里要测的）
  const first = await createRun(store, { runId: "run_b6_i1" });
  await store.updateRun("run_b6_i1", {
    status: "failed",
    errorCode: "ANSWER_NOT_FOUND",
    errorMessage: "没等到答案",
    completedAt: new Date().toISOString(),
  });

  const second = await createRun(store, { runId: "run_b6_i1", attempt: 2 });
  assert.notEqual(
    second.startedAt,
    "2026-09-18T04:28:20.898Z",
    "同批次继承的也不应是 9 月那个时间 —— 那是「同批次」之外的情形",
  );
  assert.ok(first.startedAt, "第一次应正常落盘");
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

test("★ 批次号相同时也要识别出残留（9 月也有批次 6）", async () => {
  // 2026-10-06 批次 6 的实测：run_b6_i1 的残留目录里 samplingBatchId 也是 6，
  // 于是「只比批次号」的第一版判据失效，started_at 又被沿用成 09-18。
  //
  // 补判据是**项目名** —— 它是人为起的，批次 id 是数据库序列、会因清库重排。
  const { store } = await makeStoreWithStaleRun({
    staleBatchId: 6, // ★ 批次号与本次相同
    staleProject: "probe-真实引用验证", // 9 月那个项目
  });
  const run = await createRun(store, {
    runId: "run_b6_i1",
    project: "probe-真实引用验证r6", // 本次的新项目
    accountKey: "t1_new",
  });
  assert.notEqual(
    run.startedAt,
    "2026-09-18T04:28:20.898Z",
    "批次号相同但项目不同 —— 仍须丢弃残留的 startedAt",
  );
});

test("批次、项目、账号三者任一不同都算「不是同一条 run」", async () => {
  const cases = [
    { label: "项目不同", staleProject: "旧项目", opts: { project: "新项目" } },
    { label: "账号不同", staleAccount: "t_old", opts: { accountKey: "t_new" } },
  ];
  for (const { label, staleProject, staleAccount, opts } of cases) {
    const { store } = await makeStoreWithStaleRun({
      staleBatchId: 6, // 批次号相同，制造最难的情况
      staleProject: staleProject ?? "probe-真实引用验证",
      staleAccount: staleAccount ?? "t1_new",
    });
    const run = await createRun(store, { runId: "run_b6_i1", ...opts });
    assert.notEqual(
      run.startedAt,
      "2026-09-18T04:28:20.898Z",
      `${label} 时不该沿用残留的 startedAt`,
    );
  }
});