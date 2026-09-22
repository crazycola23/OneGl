import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["src"];

/**
 * `node --check src/*.js` only works where the shell expands globs; npm on Windows runs
 * scripts through cmd.exe, which hands Node the literal `src/*.js`. Walking the tree here
 * keeps the gate identical on every platform.
 */
async function javascriptFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await javascriptFiles(full)));
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found;
}

const files = (await Promise.all(roots.map(javascriptFiles))).flat().sort();
const failed = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    failed.push(file);
    console.error(`${file}: ${String(error.stderr || error.message).trim()}`);
  }
}

console.log(`语法检查：${files.length - failed.length}/${files.length} 通过`);
if (failed.length) {
  console.error(`失败 ${failed.length} 个：${failed.join(", ")}`);
  process.exitCode = 1;
}
