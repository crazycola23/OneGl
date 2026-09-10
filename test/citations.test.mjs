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

  const config = loadConfig({ headless: true });
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
      });
    }
  } finally {
    await session.close();
  }
});
