import assert from "node:assert/strict";
import test from "node:test";
import { refreshBatchProgress } from "../src/queue/batches.js";

test("a single completed run preserves its real start time when the batch skips running", async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    return calls.length === 1 ? { rows: [{ status: "queued", requested_jobs: 1, skipped_jobs: 0, completed: 1, failed: 0 }] } : { rows: [] };
  } };
  const result = await refreshBatchProgress(pool, 148);
  assert.equal(result.status, "completed");
  assert.equal(calls[1].values[3], "completed");
  assert.match(calls[1].sql, /started_at = COALESCE\(started_at,/);
  assert.match(calls[1].sql, /SELECT min\(r\.started_at\) FROM runs r WHERE r\.sampling_batch_id = \$1/);
});
