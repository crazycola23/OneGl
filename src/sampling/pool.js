import { readFile } from "node:fs/promises";

/**
 * Keyword / Prompt pool ingestion.
 *
 * Accepts the shapes people actually keep their keyword lists in, so a 500 row pool
 * does not have to be reshaped by hand first:
 *
 *   ["20万左右新能源轿车推荐", ...]
 *   { "version": "2026-09-10", "prompts": [ { "text": "...", "category": "购买推荐" } ] }
 *   { "keywords": ["..."] }
 */

export const UNCATEGORIZED = "uncategorized";

function entryText(entry) {
  if (typeof entry === "string") return entry;
  return entry?.text ?? entry?.prompt ?? entry?.keyword ?? null;
}

export function normalizePoolPayload(payload, fallbackVersion = null) {
  let version = fallbackVersion;
  let rawEntries;

  if (Array.isArray(payload)) {
    rawEntries = payload;
  } else if (payload && typeof payload === "object") {
    version = payload.version ?? fallbackVersion;
    if (Array.isArray(payload.prompts)) rawEntries = payload.prompts;
    else if (Array.isArray(payload.keywords)) rawEntries = payload.keywords;
    else throw new Error("关键词池对象必须包含 prompts 或 keywords 数组");
  } else {
    throw new Error("关键词池必须是 JSON 数组或对象");
  }

  const prompts = [];
  const seen = new Set();
  const duplicates = [];

  for (const entry of rawEntries) {
    const text = String(entryText(entry) ?? "").trim();
    if (!text) continue;

    if (seen.has(text)) {
      duplicates.push(text);
      continue;
    }
    seen.add(text);

    const rawCategory =
      typeof entry === "string" ? null : (entry?.category ?? entry?.group ?? null);
    const category = rawCategory == null || String(rawCategory).trim() === ""
      ? UNCATEGORIZED
      : String(rawCategory).trim();

    prompts.push({
      text,
      category,
      enabled: typeof entry === "string" ? true : entry?.enabled !== false,
    });
  }

  return { version, prompts, duplicateCount: duplicates.length };
}

export async function loadPoolFile(filePath, fallbackVersion = null) {
  const raw = await readFile(filePath, "utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`关键词池文件 ${filePath} 不是合法的 JSON：${error.message}`);
  }
  return normalizePoolPayload(payload, fallbackVersion);
}

export function poolSummary(prompts) {
  const byCategory = new Map();
  for (const prompt of prompts) {
    byCategory.set(prompt.category, (byCategory.get(prompt.category) ?? 0) + 1);
  }
  return {
    total: prompts.length,
    enabled: prompts.filter((prompt) => prompt.enabled).length,
    categories: [...byCategory.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
  };
}
