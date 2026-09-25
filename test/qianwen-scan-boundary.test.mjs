import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, "..", "src", "qianwen.js"), "utf8");

/** Slice from one function declaration to the next, so the check reads the real source. */
function region(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} was not found in src/qianwen.js`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${endMarker} was not found after ${startMarker}`);
  return source.slice(start, end);
}

test("every field the page scan reads crosses the evaluate boundary", () => {
  // scanQianwenPage runs inside page.evaluate and cannot close over anything in this module, so
  // scanConfig is the only way a value reaches it. A field missing there arrives as undefined and
  // the check that reads it silently does nothing - which is exactly how the login-surface check
  // looked correct on both sides of the boundary while never firing on a real wall.
  const scan = region("function scanQianwenPage(", "function scanConfig(");
  const boundary = region("function scanConfig(", "function scanPage(");

  const read = new Set([...scan.matchAll(/cfg\.([A-Za-z0-9_]+)/g)].map((match) => match[1]));
  const passed = new Set([...boundary.matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map((match) => match[1]));

  assert.ok(read.size > 0, "no cfg.<field> reads were found, so this check is not inspecting the scan");
  assert.deepEqual([...read].filter((field) => !passed.has(field)), []);
});
