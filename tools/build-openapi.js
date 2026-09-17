import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildOpenApiDocument } from "../src/api/build-openapi.js";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

const target = resolve(process.argv[2] || "openapi.json");
await mkdir(dirname(target), { recursive: true });
const document = stable(buildOpenApiDocument());
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`OpenAPI written to ${target}`);
