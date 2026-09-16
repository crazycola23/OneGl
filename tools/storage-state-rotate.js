import "dotenv/config";

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { rotateEncryptedStorageStateFile, storageStateKeyId } from "../src/security/storage-state.js";

function parseArgs(argv) {
  const args = {
    dataDir: process.env.ONEGL_DATA_DIR || ".onegl",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--data-dir") {
      const next = argv[index + 1];
      if (!next) throw new Error("--data-dir requires a path");
      args.dataDir = next;
      index += 1;
    } else if (token.startsWith("--data-dir=")) args.dataDir = token.slice(11);
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function discoverEncryptedStates(dataDir) {
  const root = path.resolve(dataDir);
  const authDir = path.join(root, "auth");
  const results = [];
  const defaultPath = path.join(authDir, "doubao.storage.json.enc");
  if (await fileExists(defaultPath)) {
    results.push({ path: defaultPath, accountKey: null, provider: "doubao" });
  }

  const accountsDir = path.join(authDir, "accounts");
  let names = [];
  try {
    names = await readdir(accountsDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of names.sort()) {
    const suffix = ".storage.json.enc";
    if (!name.endsWith(suffix)) continue;
    const accountKey = name.slice(0, -suffix.length);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(accountKey)) {
      throw new Error(`refusing to rotate unexpected account storage-state filename: ${name}`);
    }
    results.push({
      path: path.join(accountsDir, name),
      accountKey,
      provider: "doubao",
    });
  }
  return results;
}

const args = parseArgs(process.argv.slice(2));
const oldKey = process.env.ONEGL_STORAGE_STATE_OLD_KEY;
const newKey = process.env.ONEGL_STORAGE_STATE_KEY;
if (!oldKey) throw new Error("ONEGL_STORAGE_STATE_OLD_KEY is required for rotation");
if (!newKey) throw new Error("ONEGL_STORAGE_STATE_KEY must contain the new key");
if (storageStateKeyId(oldKey) === storageStateKeyId(newKey)) {
  throw new Error("ONEGL_STORAGE_STATE_OLD_KEY and ONEGL_STORAGE_STATE_KEY are identical");
}

const states = await discoverEncryptedStates(args.dataDir);
if (!states.length) {
  console.log(JSON.stringify({ ok: true, dry_run: args.dryRun, files: 0, rotated: 0, message: "no encrypted storageState files found" }, null, 2));
  process.exit(0);
}

// Phase 1: authenticate every file before rewriting any of them. Files already using the
// new key are accepted so the command can recover after an interrupted previous rotation.
const validated = [];
for (const state of states) {
  validated.push(await rotateEncryptedStorageStateFile({
    encryptedPath: state.path,
    accountKey: state.accountKey,
    provider: state.provider,
    oldKey,
    newKey,
    dryRun: true,
  }));
}

if (args.dryRun) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    files: states.length,
    old_key_id: storageStateKeyId(oldKey),
    new_key_id: storageStateKeyId(newKey),
    already_rotated: validated.filter((item) => item.already_rotated).length,
  }, null, 2));
  process.exit(0);
}

let rotated = 0;
let alreadyRotated = 0;
for (const state of states) {
  const result = await rotateEncryptedStorageStateFile({
    encryptedPath: state.path,
    accountKey: state.accountKey,
    provider: state.provider,
    oldKey,
    newKey,
    dryRun: false,
  });
  if (result.rotated) rotated += 1;
  if (result.already_rotated) alreadyRotated += 1;
}

console.log(JSON.stringify({
  ok: true,
  dry_run: false,
  files: states.length,
  rotated,
  already_rotated: alreadyRotated,
  old_key_id: storageStateKeyId(oldKey),
  new_key_id: storageStateKeyId(newKey),
}, null, 2));
