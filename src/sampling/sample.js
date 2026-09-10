import { UNCATEGORIZED } from "./pool.js";
import { createSeededRandom, shuffle } from "./random.js";

/**
 * Deterministic prompt selection.
 *
 * The pool is sorted into a canonical order before anything is drawn, because the
 * order rows come back from PostgreSQL is not guaranteed. Without that, the same seed
 * could produce a different sample on a different day.
 */

function canonicalOrder(prompts) {
  return [...prompts].sort(
    (a, b) =>
      String(a.text).localeCompare(String(b.text)) ||
      String(a.category ?? "").localeCompare(String(b.category ?? "")) ||
      Number(a.id ?? 0) - Number(b.id ?? 0),
  );
}

export function groupByCategory(prompts) {
  const groups = new Map();
  for (const prompt of prompts) {
    const key = prompt.category || UNCATEGORIZED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(prompt);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Proportional allocation with the largest-remainder method, capped at each group's
 * size and redistributed when a group is too small to absorb its share. Full dispatch
 * beats "抽到某一种问题" without over-representing a tiny category.
 */
export function allocateQuotas(size, groups) {
  const entries = [...groups.entries()].map(([category, items]) => ({
    category,
    capacity: items.length,
  }));
  const total = entries.reduce((sum, entry) => sum + entry.capacity, 0);
  const quotas = new Map();

  if (!total || size <= 0) return quotas;

  const target = Math.min(size, total);
  const remainders = [];
  let assigned = 0;

  for (const entry of entries) {
    const exact = (target * entry.capacity) / total;
    const base = Math.min(Math.floor(exact), entry.capacity);
    quotas.set(entry.category, base);
    assigned += base;
    remainders.push({
      category: entry.category,
      remainder: exact - Math.floor(exact),
      capacity: entry.capacity - base,
    });
  }

  remainders.sort(
    (a, b) => b.remainder - a.remainder || a.category.localeCompare(b.category),
  );

  let progressed = true;
  while (assigned < target && progressed) {
    progressed = false;
    for (const entry of remainders) {
      if (assigned >= target) break;
      if (entry.capacity <= 0) continue;
      quotas.set(entry.category, quotas.get(entry.category) + 1);
      entry.capacity -= 1;
      assigned += 1;
      progressed = true;
    }
  }

  return quotas;
}

export function selectPrompts({ prompts, size, method, seed }) {
  const random = createSeededRandom(seed);
  const pool = canonicalOrder(prompts);

  if (method === "stratified") {
    const groups = groupByCategory(pool);
    const quotas = allocateQuotas(size, groups);
    const selected = [];

    for (const [category, items] of groups) {
      const take = quotas.get(category) ?? 0;
      if (take <= 0) continue;
      for (const prompt of shuffle(items, random).slice(0, take)) {
        selected.push({ ...prompt, category });
      }
    }
    return selected;
  }

  return shuffle(pool, random)
    .slice(0, Math.min(size, pool.length))
    .map((prompt) => ({ ...prompt, category: prompt.category || UNCATEGORIZED }));
}

/**
 * Hands each selected prompt to an account. Round-robin over a seed-shuffled account
 * list, so the assignment is reproducible yet never pins the first keyword to the
 * first account. With repeats > 1 the same prompt is spread across accounts, which is
 * how answer variance between accounts is measured.
 */
export function assignAccounts({ prompts, accounts, repeats = 1, seed }) {
  if (!accounts.length) throw new Error("至少需要一个账号");
  const random = createSeededRandom(`${seed}:accounts`);
  const ordered = shuffle([...accounts], random);

  const assignments = [];
  let selectionIndex = 0;
  prompts.forEach((prompt, promptIndex) => {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      selectionIndex += 1;
      assignments.push({
        prompt,
        accountKey: ordered[(promptIndex + repeat) % ordered.length],
        selectionIndex,
      });
    }
  });
  return assignments;
}
