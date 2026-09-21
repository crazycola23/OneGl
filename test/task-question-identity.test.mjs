import assert from "node:assert/strict";
import test from "node:test";

import { ApiHttpError } from "../src/api/http.js";
import {
  ASSIGNMENT_STATUSES,
  assignmentStatusFor,
  normalizeQuestionEntries,
  normalizeTaskInput,
  publicResultFields,
  QUESTION_EXTERNAL_ID_PATTERN,
  terminalReasonFor,
} from "../src/tasks/service.js";

function taskInput(questions, extra = {}) {
  return { name: "批次任务", questions, ...extra };
}

function throwsApi(error, status, code) {
  return error instanceof ApiHttpError && error.status === status && error.code === code;
}

test("normalizeTaskInput accepts object-shaped questions and keeps their mapping keys", () => {
  const parsed = normalizeTaskInput(taskInput([
    { text: "长沙腰痛调理去哪好", external_id: "q-1", category: "本地推荐", repetition_index: 1, repetition_count: 2 },
    { question: "腰椎间盘突出怎么办", external_id: "q-2" },
  ]));

  assert.deepEqual(parsed.questions, ["长沙腰痛调理去哪好", "腰椎间盘突出怎么办"]);
  assert.deepEqual(parsed.questionEntries, [
    { text: "长沙腰痛调理去哪好", externalId: "q-1", repetitionIndex: 1, repetitionCount: 2, category: "本地推荐" },
    { text: "腰椎间盘突出怎么办", externalId: "q-2", repetitionIndex: null, repetitionCount: null, category: null },
  ]);
});

test("identical question text is preserved when the external_id differs", () => {
  const parsed = normalizeTaskInput(taskInput([
    { text: "长沙腰痛调理去哪好", external_id: "obs-1" },
    { text: "长沙腰痛调理去哪好", external_id: "obs-2" },
    { text: "长沙腰痛调理去哪好", external_id: "obs-3" },
  ]));

  // Without the external_id these three rows would collapse to one and two of the three
  // requested observations would silently disappear.
  assert.equal(parsed.questions.length, 3);
  assert.deepEqual(parsed.questions, ["长沙腰痛调理去哪好", "长沙腰痛调理去哪好", "长沙腰痛调理去哪好"]);
  assert.deepEqual(parsed.questionEntries.map((entry) => entry.externalId), ["obs-1", "obs-2", "obs-3"]);
});

test("a duplicated external_id is rejected with 422 instead of hitting the unique index", () => {
  assert.throws(
    () => normalizeTaskInput(taskInput([
      { text: "问题 A", external_id: "dup-1" },
      { text: "问题 B", external_id: "dup-1" },
    ])),
    (error) => {
      assert.ok(throwsApi(error, 422, "duplicate_external_id"), `unexpected error: ${error?.code}`);
      assert.equal(error.details.external_id, "dup-1");
      return true;
    },
  );

  // Same guard on the lower-level entry normaliser.
  assert.throws(
    () => normalizeQuestionEntries([
      { text: "x", external_id: "same" },
      { text: "y", external_id: "same" },
    ]),
    (error) => throwsApi(error, 422, "duplicate_external_id"),
  );
});

test("legacy string-only questions still de-duplicate by text and stay backward compatible", () => {
  const parsed = normalizeTaskInput(taskInput([" a ", "a", "", " b ", "a"]));
  assert.deepEqual(parsed.questions, ["a", "b"]);
  assert.deepEqual(parsed.questionEntries.map((entry) => entry.externalId), [null, null]);

  // An existing task without new columns is read back through the legacy path.
  const current = { name: "旧任务", questions: ["a", "b"], platforms: ["doubao"], account_ids: [] };
  const inherited = normalizeTaskInput({ name: "旧任务" }, current);
  assert.deepEqual(inherited.questions, ["a", "b"]);
  assert.deepEqual(inherited.questionEntries.map((entry) => entry.externalId), [null, null]);
});

test("question identity validation rejects bad ids and multi-repeat external_id submissions", () => {
  assert.throws(
    () => normalizeTaskInput(taskInput([{ text: "x", external_id: "has space" }])),
    (error) => throwsApi(error, 422, "invalid_external_id"),
  );
  assert.throws(
    () => normalizeTaskInput(taskInput([{ text: "x", external_id: "a".repeat(201) }])),
    (error) => throwsApi(error, 422, "invalid_external_id"),
  );

  // external_id maps one entry to exactly one observation, so repeats must stay 1.
  assert.throws(
    () => normalizeTaskInput(taskInput([{ text: "x", external_id: "ok" }], { sampling: { repeats: 2 } })),
    (error) => throwsApi(error, 422, "external_id_requires_single_repeat"),
  );
  assert.doesNotThrow(() => normalizeTaskInput(taskInput([{ text: "x", external_id: "ok" }], { sampling: { repeats: 1 } })));
  // Without external ids repeats is still allowed.
  assert.equal(normalizeTaskInput(taskInput(["x"], { sampling: { repeats: 3 } })).repeats, 3);

  // repetition_index must not exceed repetition_count.
  assert.throws(
    () => normalizeTaskInput(taskInput([{ text: "x", repetition_index: 3, repetition_count: 2 }])),
    (error) => throwsApi(error, 422, "invalid_request"),
  );

  assert.ok(QUESTION_EXTERNAL_ID_PATTERN.test("A-Z.a_z:0-9"));
  assert.equal(QUESTION_EXTERNAL_ID_PATTERN.test("bad id"), false);
});

test("a terminal batch without a runs row reports not_collected, never pending", () => {
  for (const batchStatus of ["completed", "partial", "failed"]) {
    const status = assignmentStatusFor({ runStatus: null, batchStatus });
    assert.equal(status, "not_collected", `batch ${batchStatus} must not stay pending`);
    assert.notEqual(status, "not_started");
  }
  assert.equal(assignmentStatusFor({ runStatus: null, batchStatus: "aborted" }), "cancelled");

  // A run row that still says "pending" on a terminal execution is not collectible either.
  assert.equal(assignmentStatusFor({ runStatus: "pending", batchStatus: "completed" }), "not_collected");
  assert.equal(assignmentStatusFor({ runStatus: "pending", batchStatus: "aborted" }), "cancelled");

  // In-flight work keeps its running/not_started vocabulary.
  assert.equal(assignmentStatusFor({ runStatus: "running", batchStatus: "running" }), "running");
  assert.equal(assignmentStatusFor({ runStatus: null, batchStatus: "queued" }), "not_started");

  // Terminal statuses that did produce data stay collected.
  assert.equal(assignmentStatusFor({ runStatus: "success", batchStatus: "completed" }), "collected");
  assert.equal(assignmentStatusFor({ runStatus: "partial", batchStatus: "partial" }), "collected");
  assert.equal(assignmentStatusFor({ runStatus: "failed", batchStatus: "completed" }), "not_collected");

  // "pending" is not even part of the public assignment vocabulary.
  assert.equal(ASSIGNMENT_STATUSES.includes("pending"), false);
});

test("terminal_reason explains why a terminal assignment produced nothing", () => {
  assert.deepEqual(
    terminalReasonFor({ runStatus: null, batchStatus: "aborted" }),
    { code: "execution_cancelled", message: "execution was cancelled before this question was collected" },
  );
  const skipped = terminalReasonFor({ runStatus: null, batchStatus: "completed" });
  assert.equal(skipped.code, "assignment_skipped");
  assert.match(skipped.message, /no collection run was recorded/);

  assert.deepEqual(
    terminalReasonFor({ runStatus: "failed", errorCode: "account_access_restricted", errorMessage: "blocked" }),
    { code: "account_access_restricted", message: "blocked" },
  );
  assert.equal(terminalReasonFor({ runStatus: "success", batchStatus: "completed" }), null);
  assert.equal(terminalReasonFor({ runStatus: null, batchStatus: "running" }), null);
});

test("publicResultFields projects a terminal no-run assignment without leaking internals", () => {
  const fields = publicResultFields({
    external_id: "obs-9",
    repetition_index: 2,
    repetition_count: 2,
    batch_status: "completed",
    run_status: null,
    task_public_id: "tsk_0123456789abcdef0123456789abcdef",
    execution_public_id: "exe_0123456789abcdef0123456789abcdef",
  });

  assert.equal(fields.assignment_status, "not_collected");
  assert.equal(fields.question_external_id, "obs-9");
  assert.equal(fields.repetition_index, 2);
  assert.equal(fields.repetition_count, 2);
  assert.equal(fields.terminal_reason.code, "assignment_skipped");
  assert.equal(fields.task_id, "tsk_0123456789abcdef0123456789abcdef");
  assert.equal(fields.execution_id, "exe_0123456789abcdef0123456789abcdef");

  const aborted = publicResultFields({ batch_status: "aborted", run_status: null });
  assert.equal(aborted.assignment_status, "cancelled");
  assert.equal(aborted.terminal_reason.code, "execution_cancelled");
});
