/**
 * 引用采集审计（第四轮）：点中「N篇来源」这个可展开入口，把源列表掏出来。
 *
 * 已确认的结构线索：
 *   - 入口在 [data-answer-feedback-toolbar="true"] 里，文本形如「9篇来源」。
 *   - 它旁边有一个 cursor-pointer 的兄弟节点（前几轮看到 clickable:true）。
 *   - 源标题挂在 [class*="link-title"] 上；答案卡片容器是 .chat-answers-card-wrap。
 *   - 默认是折叠的：整页只有一个 link-title（就是那句「9篇来源」本身）。
 */
import { setTimeout as delay } from "node:timers/promises";

import { launchBrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { executeQianwenPrompt, openQianwen } from "../src/qianwen.js";
import { qianwenWebProfile } from "../src/providers/qianwen-web.js";

const config = loadConfig({ provider: "qianwen", storageState: null, headless: true });
const PROMPT = "绍兴越城区推拿按摩哪家手法好？";

const session = await launchBrowserSession(config);
const { page } = session;
const log = (s, d = "") => console.log(`[c4] ${s}${d ? ` :: ${d}` : ""}`);

/** 把工具栏里所有可点子节点的结构打出来（找真正的展开入口）。 */
async function toolBarMap() {
  return page.evaluate(() => {
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const bar = document.querySelector('[data-answer-feedback-toolbar="true"]');
    if (!bar) return { found: false };
    const nodes = [...bar.querySelectorAll("*")]
      .filter((el) => el.children.length === 0 || el.tagName === "BUTTON" || el.tagName === "A")
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: norm(el.innerText).slice(0, 30),
        cursor: getComputedStyle(el).cursor,
        titleAttr: el.getAttribute("title"),
        aria: el.getAttribute("aria-label"),
        href: el.getAttribute("href"),
        stableClass: [...el.classList].filter((c) => !/-[A-Za-z0-9_]{6}$/.test(c)).slice(0, 3),
      }))
      .filter((n) => n.text || n.href || n.titleAttr);
    return { found: true, nodes: nodes.slice(0, 25) };
  });
}

async function harvest(label) {
  const data = await page.evaluate(() => {
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const linkNodes = [...document.querySelectorAll('[class*="link-title"]')];
    return {
      linkTitleCount: linkNodes.length,
      linkTitles: linkNodes.map((n) => ({
        text: norm(n.innerText).slice(0, 60),
        url: n.getAttribute("href") || n.getAttribute("data-url") || n.getAttribute("title"),
        parentText: norm(n.parentElement?.innerText).slice(0, 60),
      })).slice(0, 20),
      anchors: [...new Set([...document.querySelectorAll("a")].map((a) => a.href).filter(Boolean))].slice(0, 20),
      cardWrap: (() => {
        const w = document.querySelector(".chat-answers-card-wrap");
        return w ? norm(w.innerText).slice(0, 200) : null;
      })(),
    };
  });
  console.log(`\n=== ${label} ===`);
  console.log("link-title 数量:", data.linkTitleCount);
  console.log(JSON.stringify(data.linkTitles, null, 1).slice(0, 1200));
  console.log("锚点数:", data.anchors.length, JSON.stringify(data.anchors.slice(0, 8)));
  return data;
}

try {
  await openQianwen(page, config, qianwenWebProfile);
  await delay(2_000);
  const result = await executeQianwenPrompt(page, PROMPT, config, qianwenWebProfile);
  log("采集完成", `answer=${(result.answer || "").length}字 citations=${result.citations?.length ?? 0}`);

  console.log("\n=== 工具栏节点 ===");
  console.log(JSON.stringify(await toolBarMap(), null, 1));
  await harvest("点击前");

  // 用 JS 在工具栏里找 cursor:pointer 且文本含「来源」的节点点击
  const clicked = await page.evaluate(() => {
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const bar = document.querySelector('[data-answer-feedback-toolbar="true"]');
    if (!bar) return "no-bar";
    const cands = [...bar.querySelectorAll("*")].filter((el) => {
      const c = getComputedStyle(el).cursor;
      return c === "pointer" && /来源/.test(norm(el.innerText));
    });
    if (cands.length === 0) {
      // 退一步：文本正好是「N篇来源」的那个
      const t = [...bar.querySelectorAll("*")].find((el) => /^\d+篇来源$/.test(norm(el.innerText)));
      if (t) { t.click(); return "clicked-text-node"; }
      return "no-candidate";
    }
    cands[0].click();
    return `clicked(${norm(cands[0].innerText).slice(0, 12)})`;
  });
  log("展开动作", clicked);
  await delay(4_000);
  await harvest("点击后");

  // 再等久一点，有些列表是异步加载的
  await delay(4_000);
  await harvest("再等 4 秒后");
} catch (error) {
  console.log("失败:", error?.message);
} finally {
  await session.close().catch(() => undefined);
}
