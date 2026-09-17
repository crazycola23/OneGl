import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildOpenApiDocument } from "../src/api/build-openapi.js";
import { openApiDocument } from "../src/api/openapi.js";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

test("runtime export and committed static OpenAPI derive from the same builder", async () => {
  const built = buildOpenApiDocument();
  const staticText = await readFile(new URL("../openapi.json", import.meta.url), "utf8");
  const staticDocument = JSON.parse(staticText);

  assert.deepEqual(openApiDocument, built);
  assert.deepEqual(staticDocument, stable(built));
  assert.equal(staticText, `${JSON.stringify(stable(built), null, 2)}\n`);
});
