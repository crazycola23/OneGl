import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";

/**
 * Strips personal data out of captured DOM fixtures.
 *
 * A `page.content()` snapshot is the whole page, which includes the Doubao sidebar
 * (conversation list, avatar, subscription badge) and an inline `_ROUTER_DATA` script
 * holding account metadata - real account details that must never reach a public repo.
 * The citation extractor only needs the rendered message area, so everything else is
 * removed here.
 *
 * Run this after adding any new fixture, then re-run `npm test` to confirm the
 * expected citation counts still reproduce:
 *
 *   npm run fixtures:sanitize
 */

const FIXTURES_DIR = path.resolve("test/fixtures");

// Runs inside the browser against the loaded fixture.
const SANITIZER = () => {
  const drop = (selector) => {
    for (const element of document.querySelectorAll(selector)) element.remove();
  };

  // Inline scripts carry _ROUTER_DATA: avatar URLs, linked platform accounts,
  // login state and other account metadata.
  drop("script");
  // The sidebar holds the user's conversation list, avatar and plan badge.
  drop("#flow_chat_sidebar");
  drop("nav");
  // Images point at signed personal avatar CDN URLs.
  drop("img");
  drop("iframe");
  drop('link[rel="preload"], link[rel="prefetch"], link[rel="dns-prefetch"]');

  // Any remaining attribute that could hold a token.
  for (const element of document.querySelectorAll("*")) {
    for (const name of [...element.getAttributeNames()]) {
      if (/^(on|data-e2e-session|data-token)/i.test(name)) element.removeAttribute(name);
    }
  }

  return document.documentElement.outerHTML;
};

async function main() {
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith(".html.gz")).sort();
  if (!names.length) throw new Error(`No fixtures found in ${FIXTURES_DIR}`);

  const config = loadConfig({ headless: true });
  const session = await launchBrowserSession(config, { headless: true });

  try {
    for (const name of names) {
      const base = name.replace(/\.html\.gz$/, "");
      const htmlPath = path.join(FIXTURES_DIR, name);
      const metaPath = path.join(FIXTURES_DIR, `${base}.json`);

      const original = gunzipSync(await readFile(htmlPath)).toString("utf8");
      const meta = JSON.parse(await readFile(metaPath, "utf8"));

      await session.page.setContent(original, { waitUntil: "domcontentloaded" });
      const cleaned = await session.page.evaluate(SANITIZER);

      await writeFile(htmlPath, gzipSync(Buffer.from(cleaned, "utf8"), { level: 9 }));
      await writeFile(
        metaPath,
        `${JSON.stringify(
          {
            ...meta,
            sanitized: true,
            originalHtmlBytes: meta.originalHtmlBytes ?? original.length,
            sanitizedHtmlBytes: cleaned.length,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      console.log(
        `${base}: ${original.length} -> ${cleaned.length} bytes ` +
          `(${((1 - cleaned.length / original.length) * 100).toFixed(0)}% removed)`,
      );
    }
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
