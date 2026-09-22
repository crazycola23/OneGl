import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { launchBrowserSession } from "../src/browser.js";
import {
  captureOpenQuestions,
  collectPageSignals,
  externalLinkHosts,
  rankAnswerCandidates,
  suggestSelectors,
} from "../src/providers/phase0.js";
import { deriveSessionCookieCandidates } from "../src/providers/profile.js";
import { pendingProviderProfiles, providerProfileGaps } from "../src/providers/index.js";

/**
 * Measure a provider before believing it.
 *
 *   node tools/provider-phase0.js --profile yuanbao-web --stage anonymous
 *   node tools/provider-phase0.js --profile yuanbao-web --stage login
 *   node tools/provider-phase0.js --profile yuanbao-web --stage chat --prompt "..."
 *   node tools/provider-phase0.js --profile yuanbao-web --stage report
 *
 * Cookie *values* are never written anywhere - only their presence and length, which is all
 * the diff needs. Snapshots land under .onegl/phase0/ (git-ignored evidence, not fixtures).
 */

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
}

const profileId = flag("profile") ?? "yuanbao-web";
const stage = flag("stage") ?? "report";
const profile = pendingProviderProfiles.find((entry) => entry.id === profileId);
if (!profile) {
  console.error(`未知 profile：${profileId}。可选：${pendingProviderProfiles.map((p) => p.id).join(", ")}`);
  process.exit(1);
}

const snapshotDir = path.join(".onegl", "phase0");
const snapshotPath = (kind) => path.join(snapshotDir, `${profileId}.${kind}.json`);

async function readSnapshot(kind) {
  try {
    return JSON.parse(await readFile(snapshotPath(kind), "utf8"));
  } catch {
    return null;
  }
}

async function writeSnapshot(kind, payload) {
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  await writeFile(snapshotPath(kind), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`已写入 ${snapshotPath(kind)}`);
}

// Presence-only view, so the shared differ sees "empty -> non-empty" without ever holding a
// credential value on disk.
const cookieMap = (snapshot) =>
  Object.fromEntries((snapshot?.cookies ?? []).map((entry) => [entry.name, String(entry.valueLength ?? 0)]));

async function capture({ ignoreStoredAuth = true, waitForLogin = false, prompt = null } = {}) {
  const config = loadConfig({ provider: profile.provider, headless: ignoreStoredAuth && !waitForLogin });
  const session = await launchBrowserSession(config, { ignoreStoredAuth, forceHeadful: waitForLogin });
  try {
    const page = session.page;
    await page.goto(profile.entryUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(4_000);

    if (waitForLogin) {
      console.log("请在打开的窗口里完成登录（扫码或手机号）。本工具不代填、不解析验证码。");
      const deadline = Date.now() + 300_000;
      for (;;) {
        const signals = await page.evaluate(collectPageSignals);
        const diff = deriveSessionCookieCandidates(cookieMap(await readSnapshot("anonymous")), cookieMap(signals));
        if (diff.candidates.length) {
          console.log(`检测到 ${diff.candidates.length} 个登录后新增/变值的 cookie，停止等待。`);
          return { signals, diff, page };
        }
        if (Date.now() > deadline) {
          console.log("等待超时：没有观测到会话 cookie 变化。");
          return { signals, diff, page };
        }
        await page.waitForTimeout(3_000);
      }
    }

    if (prompt) {
      const composer = flag("composer");
      const send = flag("send");
      if (!composer || !send) {
        console.error("chat 阶段需要 --composer <selector> 与 --send <selector>，取值先看 anonymous 阶段的 inputs/buttons。");
        return { signals: await page.evaluate(collectPageSignals), page };
      }
      await page.locator(composer).first().fill(prompt);
      await page.locator(send).first().click({ force: true }).catch(async () => {
        await page.locator(send).first().dispatchEvent("click");
      });
      await page.waitForTimeout(Number(flag("wait") ?? 25_000));
    }

    return { signals: await page.evaluate(collectPageSignals), page };
  } finally {
    await session.close().catch(() => undefined);
  }
}

function summarize(signals, { prompt = null, previous = null } = {}) {
  const selfHost = (() => {
    try {
      return new URL(profile.entryUrl).hostname;
    } catch {
      return null;
    }
  })();
  return {
    at: new Date().toISOString(),
    url: signals.url,
    title: signals.title,
    historyLength: signals.historyLength,
    cookies: signals.cookies,
    localStorageKeys: signals.localStorageKeys,
    inputs: signals.inputs,
    buttons: signals.buttons.filter((entry) => entry.text || entry.testid || entry.aria),
    dialogs: signals.dialogs.map((entry) => entry.text).filter(Boolean).slice(0, 12),
    suggestedComposerSelectors: suggestSelectors(signals.inputs),
    suggestedSendSelectors: suggestSelectors(
      signals.buttons.filter((entry) => /发送|send/i.test(`${entry.text} ${entry.aria ?? ""} ${entry.testid ?? ""}`)),
    ),
    suggestedAnswerSelectors: rankAnswerCandidates(signals.textBlocks, prompt).map((entry) => ({
      selector: suggestSelectors([entry])[0] ?? null,
      length: entry.length,
      sample: entry.text.slice(0, 80),
    })),
    citationCardHosts: externalLinkHosts(signals.links, selfHost ? [selfHost] : []),
    qrSurfaceObserved: signals.qrCandidates.some((entry) => entry.width >= 80 && entry.height >= 80),
    loginSurfaceText: signals.dialogs
      .map((entry) => entry.text)
      .filter((text) => /登录|扫码/.test(text))
      .slice(0, 4),
    cookieDiffAgainstAnonymous: previous
      ? deriveSessionCookieCandidates(cookieMap(previous), cookieMap(signals)).candidates
      : null,
  };
}

if (stage === "anonymous") {
  const { signals } = await capture({ ignoreStoredAuth: true });
  await writeSnapshot("anonymous", summarize(signals));
} else if (stage === "login") {
  const anonymous = await readSnapshot("anonymous");
  if (!anonymous) {
    console.error("先跑 --stage anonymous，否则无法分辨哪些 cookie 是登录之后才出现的。");
    process.exit(1);
  }
  const { signals } = await capture({ waitForLogin: true });
  await writeSnapshot("logged-in", summarize(signals, { previous: anonymous }));
} else if (stage === "chat") {
  const prompt = flag("prompt");
  if (!prompt) {
    console.error("chat 阶段需要 --prompt \"...\"，建议用一条明显会触发联网引用的问题。");
    process.exit(1);
  }
  const { signals } = await capture({ ignoreStoredAuth: false, prompt });
  await writeSnapshot("chat", summarize(signals, { prompt }));
} else if (stage === "report") {
  const [anonymous, loggedIn, chat] = await Promise.all([
    readSnapshot("anonymous"),
    readSnapshot("logged-in"),
    readSnapshot("chat"),
  ]);
  if (!anonymous) {
    console.error(`还没有任何观测记录：${snapshotPath("anonymous")} 不存在。`);
    process.exit(1);
  }
  const capture_ = {
    hasLoggedIn: Boolean(loggedIn?.cookieDiffAgainstAnonymous?.length),
    qrSurfaceObserved: Boolean(chat?.qrSurfaceObserved ?? anonymous?.qrSurfaceObserved),
    expiredQrObserved: null,
    answerCandidates: chat?.suggestedAnswerSelectors ?? [],
    selfReportedCitationCount: undefined,
    conversationUrlObserved: Boolean(chat && chat.url !== anonymous.url),
  };

  console.log(`\n=== ${profileId} Phase 0 结论 ===`);
  console.log(`档案还缺 ${providerProfileGaps(profileId).length} 项才能注册为 adapter：`);
  for (const gap of providerProfileGaps(profileId)) console.log(`  - ${gap}`);
  console.log("\n观测到的登录态候选：");
  for (const entry of loggedIn?.cookieDiffAgainstAnonymous ?? []) {
    console.log(`  ${entry.name}  匿名=${entry.anonymousValue ?? "(无)"} → 登录后长度 ${entry.loggedInValue}`);
  }
  console.log("\n答案容器候选（按文本长度）：");
  for (const entry of chat?.suggestedAnswerSelectors ?? []) {
    console.log(`  ${entry.selector ?? "(无法生成稳定选择器)"}  len=${entry.length}  ${entry.sample}`);
  }
  console.log("\n站外链接主机（引用卡候选）：");
  for (const entry of (chat ?? anonymous).citationCardHosts.slice(0, 10)) {
    console.log(`  ${entry.host} × ${entry.count}`);
  }
  console.log("\n仍需人工确认：");
  for (const question of captureOpenQuestions(capture_)) console.log(`  ! ${question}`);
} else {
  console.error(`未知 stage：${stage}`);
  process.exit(1);
}
