import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/live-canary.yml", import.meta.url);

test("live Doubao canary exercises the production Camoufox browser path", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /ONEGL_BROWSER:\s*camoufox/);
  assert.match(workflow, /ONEGL_CAMOUFOX_PYTHON:\s*python/);
  assert.match(workflow, /python -m camoufox set official\/stable/);
  assert.match(workflow, /python -m camoufox fetch/);
  assert.doesNotMatch(workflow, /ONEGL_BROWSER:\s*firefox/);
});

test("live canary keeps network evidence disabled until that evidence path is validated", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /ONEGL_NETWORK_EVIDENCE:\s*"false"/);
});
