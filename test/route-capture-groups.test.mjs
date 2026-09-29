import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 路由捕获组布局回归测试。
 *
 * ## 真实事故（这个端点上发生过两次）
 *
 * 检索端点最初写成 `/^\/v1\/(tasks\/(tsk_…)|task-groups\/(grp_…))\/answers\/search$/`。
 * 这个布局下 group 形态的 `match[2]` 是 **undefined**，id 落在 `match[3]`；
 * 而把外层改成 `(?:…)` 之后 `match[1]/match[2]` 才是两个 id。
 * 两种写法看起来等价，实际含义完全不同，没有硬规则可循。
 *
 * 实际症状：路由按 `match[1] ?? null` 传 taskId，group 请求把
 * `"task-groups/grp_…"` 整段当 task id 传下去 → scope 查询落空 →
 * "task was not found" → 500。
 *
 * 为什么单测没抓到：所有测试都直接调服务层（`searchAnswers({groupId})` 正常返回
 * 69 条），**路由层一行都没覆盖**。这是「服务层测过 ≠ 端点能用」最典型的一次。
 *
 * 修复：改用命名捕获组。本测试做两件事：
 *   1. 断言源码里三个路由都用命名组（防回退到位置索引）
 *   2. 用与源码字面量相同的正则跑一遍，验证解包行为
 */

const source = readFileSync(new URL("../src/api/task-routes.js", import.meta.url), "utf8");

// 与源码里的正则保持字面一致。测试与实现同源，行为变了这里会跟着变，
// 所以它的价值在于「捕获组布局」这个约定本身，而不是正则文本。
const LIST_RE = /^\/v1\/(?:tasks\/(?<taskId>tsk_[a-f0-9]+)|task-groups\/(?<groupId>grp_[a-f0-9]+))\/answers$/;
const SEARCH_RE = /^\/v1\/(?:tasks\/(?<taskId>tsk_[a-f0-9]+)|task-groups\/(?<groupId>grp_[a-f0-9]+))\/answers\/search$/;
const ONE_RE = /^\/v1\/(?:tasks\/(?<taskId>tsk_[a-f0-9]+)|task-groups\/(?<groupId>grp_[a-f0-9]+))\/answers\/(?<runId>run_[A-Za-z0-9_-]+)$/;

const GROUP = "grp_" + "a".repeat(32);
const TASK = "tsk_" + "b".repeat(32);
const RUN = "run_b68_i12";

test("三个回答路由都用命名捕获组，不回退到位置索引", () => {
  for (const [label, marker] of [
    ["抽样", "answerScope = pathname.match"],
    ["检索", "const answerSearch = pathname.match"],
    ["单条", "const answerOne = pathname.match"],
  ]) {
    const at = source.indexOf(marker);
    assert.ok(at >= 0, `源码应含 ${label} 路由`);
    const block = source.slice(at, at + 220);
    assert.match(block, /<taskId>/, `${label} 路由应有命名组 taskId`);
    assert.match(block, /<groupId>/, `${label} 路由应有命名组 groupId`);
    assert.doesNotMatch(block, /\/\(tasks\\\/|task-groups\\\/\(grp_/,
      `${label} 路由不应再用位置索引写法`);
  }
  const oneBlock = source.slice(source.indexOf("const answerOne = pathname.match"),
    source.indexOf("const answerOne = pathname.match") + 220);
  assert.match(oneBlock, /<runId>/, "单条路由应有命名组 runId");
});

test("抽样路由：group 形态解出 groupId 而非整段路径", () => {
  const m = LIST_RE.exec(`/v1/task-groups/${GROUP}/answers`);
  assert.ok(m, "应匹配");
  assert.equal(m.groups.taskId, undefined, "关键回归：group 形态 taskId 必须为空");
  assert.equal(m.groups.groupId, GROUP);
  assert.ok(!m.groups.groupId.includes("/"), "groupId 不能含斜杠");
});

test("抽样路由：task 形态解出 taskId", () => {
  const m = LIST_RE.exec(`/v1/tasks/${TASK}/answers`);
  assert.ok(m);
  assert.equal(m.groups.taskId, TASK);
  assert.equal(m.groups.groupId, undefined);
});

test("检索路由：两种形态都解出正确的 id", () => {
  const g = SEARCH_RE.exec(`/v1/task-groups/${GROUP}/answers/search`);
  assert.ok(g);
  assert.equal(g.groups.taskId, undefined);
  assert.equal(g.groups.groupId, GROUP);

  const t = SEARCH_RE.exec(`/v1/tasks/${TASK}/answers/search`);
  assert.equal(t.groups.taskId, TASK);
  assert.equal(t.groups.groupId, undefined);
});

test("单条全文路由：runId 与 scope 都正确", () => {
  const m = ONE_RE.exec(`/v1/task-groups/${GROUP}/answers/${RUN}`);
  assert.ok(m);
  assert.equal(m.groups.runId, RUN);
  assert.equal(m.groups.groupId, GROUP);
  assert.equal(m.groups.taskId, undefined);
});

test("检索正则不会误吃抽样路径", () => {
  assert.equal(SEARCH_RE.exec(`/v1/task-groups/${GROUP}/answers`), null);
});

test("单条全文正则不会误吃检索路径", () => {
  assert.equal(ONE_RE.exec(`/v1/task-groups/${GROUP}/answers/search`), null);
});

test("非法 id 字符被拒", () => {
  assert.equal(SEARCH_RE.exec("/v1/task-groups/grp_ZZZ/answers/search"), null);
  assert.equal(ONE_RE.exec("/v1/tasks/tsk_ZZZ/answers/run_1"), null);
});
