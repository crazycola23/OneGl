import "dotenv/config";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { extractVisibleCitations } from "../src/doubao.js";

/**
 * Regression guard for the citation extractor.
 *
 * Every fixture under test/fixtures is the real page.html a Doubao run produced,
 * stored next to the result that run recorded (`expected 18 / captured 18`). The
 * extractor is replayed against the genuine DOM, so any change that breaks
 * citation capture - or that starts inventing citations - fails here instead of
 * silently writing wrong rows into PostgreSQL.
 *
 * This is an offline DOM regression test, not a production-browser compatibility
 * test. Use ordinary Playwright Chromium explicitly so CI does not depend on the
 * optional Camoufox Python/runtime installation used by some live collectors.
 */

const FIXTURES_DIR = path.resolve("test/fixtures");

async function loadFixtures() {
  const names = (await readdir(FIXTURES_DIR))
    .filter((name) => name.endsWith(".html.gz"))
    .sort();

  const fixtures = [];
  for (const name of names) {
    const base = name.replace(/\.html\.gz$/, "");
    fixtures.push({
      name: base,
      html: gunzipSync(await readFile(path.join(FIXTURES_DIR, name))).toString("utf8"),
      meta: JSON.parse(await readFile(path.join(FIXTURES_DIR, `${base}.json`), "utf8")),
    });
  }
  return fixtures;
}

test("citation extraction reproduces the recorded result for every real DOM fixture", async (t) => {
  const fixtures = await loadFixtures();
  assert.ok(fixtures.length > 0, "no fixtures found under test/fixtures");

  const config = loadConfig({ browser: "chromium", headless: true });
  const session = await launchBrowserSession(config, { headless: true });

  try {
    // Fixtures are offline snapshots; a stray asset request must not hang the suite.
    await session.page.route("**", (route) => route.abort().catch(() => undefined));

    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        await session.page.setContent(fixture.html, { waitUntil: "domcontentloaded" });
        const result = await extractVisibleCitations(session.page);

        assert.equal(
          result.state,
          fixture.meta.expectedState,
          `${fixture.name}: citation state`,
        );
        assert.equal(
          result.citations.length,
          fixture.meta.expectedCitations,
          `${fixture.name}: captured citations`,
        );
        if (fixture.meta.expectedCount != null) {
          assert.equal(
            result.expectedCount,
            fixture.meta.expectedCount,
            `${fixture.name}: UI-declared citation count`,
          );
        }

        // The extractor must always report *why* a declared count and a captured count
        // differ, so a mismatch is diagnosable from the run artifact alone.
        // Provenance is only meaningful once an answer root was located: when the
        // platform silently dropped the prompt there is no answer to attribute a
        // selector to, and the extractor reports null rather than guessing.
        if (result.answerRootFound) {
          assert.equal(
            typeof result.selectorUsed,
            "string",
            `${fixture.name}: selector provenance`,
          );
        } else {
          assert.equal(
            result.selectorUsed,
            null,
            `${fixture.name}: no answer root means no selector provenance`,
          );
        }
        assert.ok(result.counts, `${fixture.name}: structured counts`);
        assert.equal(
          result.counts.captured,
          result.citations.length,
          `${fixture.name}: counts.captured matches the emitted citations`,
        );
        assert.equal(
          result.counts.expected,
          result.expectedCount,
          `${fixture.name}: counts.expected matches the UI signal`,
        );
        if (result.counts.expected !== null && result.counts.expected !== result.counts.captured) {
          assert.match(
            result.counts.diagnostic,
            /^reference-count-mismatch:/,
            `${fixture.name}: mismatch carries a machine-readable diagnostic`,
          );
          assert.ok(
            result.diagnostics.includes(result.counts.diagnostic),
            `${fixture.name}: mismatch diagnostic is surfaced on the result`,
          );
        }
      });
    }
  } finally {
    await session.close();
  }
});

/**
 * 引用块必须归属「本轮答案」，不能靠「页面最后一个」猜。
 *
 * 2026-10-05 实测（基于 fixture doubao-2026-10-05-cited 注入第二个引用块）：
 * 豆包把引用区渲染在**答案上方**，是答案的前置兄弟。而旧代码选块只有两条路：
 * 向上爬祖先链 + 全局 .at(-1)，两处都不看位置。祖先链的作用域（消息容器）
 * 同时装着本轮引用块与下一轮内容，于是 matches.at(-1) 会取到**下一轮**的块。
 *
 * 这个缺陷在计数上完全看不出来：抓错块和抓对块都是 11 条，counts 全部一致，
 * 只有归属错了 —— 报告里会把 A 问的引用算到 B 的答案上。所以必须单独断言
 * 「抓到的是哪一块」，不能只断言数量。
 */
test("citation block must belong to this answer, not the last one on the page", async () => {
  const fixture = JSON.parse(
    await readFile(path.join(FIXTURES_DIR, "doubao-2026-10-05-cited.json"), "utf8"),
  );
  const html = gunzipSync(
    await readFile(path.join(FIXTURES_DIR, "doubao-2026-10-05-cited.html.gz")),
  ).toString("utf8");

  const STALE_HOST = "stale-next-turn.example.com";
  const config = loadConfig({ browser: "chromium", headless: true });
  const session = await launchBrowserSession(config, { headless: true });

  try {
    await session.page.route("**", (route) => route.abort().catch(() => undefined));
    await session.page.setContent(html, { waitUntil: "domcontentloaded" });

    // 在本轮答案之后插入一个「下一轮」的引用块，模拟追问场景。
    // 插入点必须用与源码一致的答案选择逻辑（visible + isUserBubble 过滤），
    // 否则造出来的场景与真实执行路径对不上 —— 这个坑踩过一次。
    const setup = await session.page.evaluate((staleHost) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const isUserBubble = (el) => {
        let n = el;
        for (let d = 0; n && d < 6; d += 1) {
          const tokens = String(n.getAttribute("class") || "").split(/\s+/);
          if (tokens.includes("justify-end")) return true;
          n = n.parentElement;
        }
        return false;
      };
      const answers = [...document.querySelectorAll(
        '.md-box-root, [class*="md-box-root"], [data-testid="message_text_content"], ' +
        '[data-testid="message_content"], .flow-markdown-body',
      )]
        .filter(visible)
        .filter((el) => !isUserBubble(el));
      const answer = answers.at(-1);
      const block = document.querySelector('[data-plugin-identifier*="block_type:10025"]');
      if (!answer || !block) return { ok: false };
      const stale = block.cloneNode(true);
      const anchor = stale.querySelector("a[href]");
      if (anchor) anchor.setAttribute("href", `https://${staleHost}/next-turn`);
      answer.after(stale);
      return { ok: true, blocks: document.querySelectorAll('[data-plugin-identifier*="block_type:10025"]').length };
    }, STALE_HOST);
    assert.ok(setup.ok, "fixture 应同时含答案节点与引用块");
    assert.equal(setup.blocks, 2, "场景构造：页面里应有两个引用块");

    const result = await extractVisibleCitations(session.page);

    const leaked = result.citations.filter((c) => String(c.url).includes(STALE_HOST));
    assert.equal(
      leaked.length,
      0,
      "抓到的是「下一轮」的引用块 —— 答案与引用错配，报告里会把 A 问的引用算到 B 上",
    );
    assert.equal(
      result.citations.length,
      fixture.expectedCitations,
      "数量不应因选块错误而变化（错块与对块条数相同，只有归属错）",
    );
    assert.equal(
      result.citations[0]?.url,
      "https://iveise.com/blogs/how-to/fingerprint-door-lock-not-working-troubleshooting-checklist",
      "首条引用应来自本轮答案自己的引用块",
    );
  } finally {
    await session.close();
  }
});
