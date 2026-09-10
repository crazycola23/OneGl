import "dotenv/config";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { launchBrowserSession } from "./browser.js";
import {
  executeDoubaoPrompt,
  inspectSession,
  openDoubao,
  waitForManualLogin,
} from "./doubao.js";
import {
  ErrorCode,
  normalizeError,
  SESSION_BLOCKING_CODES,
} from "./errors.js";
import { RunStore } from "./store.js";

function parseArgs(tokens) {
  const args = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function printHelp() {
  console.log(`OneGl Doubao MVP

Commands:
  npm run auth
  npm run run -- --prompt "你的问题" [--project "项目名"]
  npm run batch -- --file prompts.example.json [--delay-ms 5000]
  npm run runs
  npm run serve

The auth command opens a headful browser, waits for manual login, and stores only
Playwright storageState under .onegl/. Do not paste cookies or tokens into chat.`);
}

async function captureArtifacts(store, runId, page) {
  if (!page) return;
  try {
    await store.writeArtifact(runId, "page.html", await page.content());
  } catch {
    // Debug capture must never hide the primary run error.
  }
  try {
    await store.writeArtifact(
      runId,
      "screenshot.png",
      await page.screenshot({ fullPage: true }),
    );
  } catch {
    // Same rule as above.
  }
}

async function executeOne({ page, store, config, prompt, project }) {
  const run = await store.createRun({ prompt, project });
  try {
    const result = await executeDoubaoPrompt(page, prompt, config);
    await captureArtifacts(store, run.id, page);
    await store.writeArtifact(run.id, "answer.md", `${result.answer}\n`);
    await store.writeArtifact(
      run.id,
      "citations.json",
      `${JSON.stringify(result.citations, null, 2)}\n`,
    );

    const partial = result.citationState === "parse_failed";
    const saved = await store.updateRun(run.id, {
      status: partial ? "partial" : "success",
      completedAt: new Date().toISOString(),
      answer: result.answer,
      citations: result.citations,
      citationState: result.citationState,
      expectedCitationCount: result.expectedCitationCount,
      citationDiagnostics: result.citationDiagnostics,
      submissionMethod: result.submissionMethod,
      conversationReset: result.conversationReset,
      currentUrl: result.currentUrl,
      errorCode: partial ? ErrorCode.CITATION_PARSE_FAILED : null,
      errorMessage: partial
        ? "The answer was captured, but visible citation extraction did not match the UI evidence."
        : null,
    });

    console.log(
      `${saved.id}: ${saved.status} | citations=${saved.citations.length}` +
        (saved.expectedCitationCount == null
          ? ""
          : `/${saved.expectedCitationCount}`),
    );
    return saved;
  } catch (error) {
    await captureArtifacts(store, run.id, page);
    const normalized = normalizeError(error);
    const partialAnswer = normalized.details?.partialAnswer || null;
    if (partialAnswer) {
      await store.writeArtifact(run.id, "partial-answer.md", `${partialAnswer}\n`);
    }
    const saved = await store.updateRun(run.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      answer: partialAnswer,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      errorDetails: normalized.details,
      currentUrl: page?.url?.() || null,
    });
    console.error(`${saved.id}: failed | ${saved.errorCode}: ${saved.errorMessage}`);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      runId: saved.id,
      normalized,
    });
  }
}

async function authCommand() {
  const config = loadConfig({ headless: false });
  const session = await launchBrowserSession(config, { forceHeadful: true });
  try {
    await openDoubao(session.page, config);
    const initial = await inspectSession(session.page);
    if (initial.state !== "healthy") {
      console.log(
        "Complete Doubao login in the opened browser window. The process will detect a healthy chat session automatically.",
      );
      await waitForManualLogin(session.page, config);
    }
    await session.saveAuth();
    console.log(`Doubao session saved to ${config.authStatePath}`);
  } finally {
    await session.close();
  }
}

async function runCommand(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new Error("--prompt is required");
  const project = typeof args.project === "string" ? args.project : "default";
  const config = loadConfig();
  const store = new RunStore(config);
  const session = await launchBrowserSession(config);
  try {
    await openDoubao(session.page, config);
    await executeOne({ page: session.page, store, config, prompt, project });
  } finally {
    await session.close();
  }
}

function normalizePromptFile(payload, args) {
  if (Array.isArray(payload)) {
    return {
      project: typeof args.project === "string" ? args.project : "default",
      prompts: payload.map((item, index) =>
        typeof item === "string"
          ? { id: `prompt_${index + 1}`, text: item, enabled: true }
          : item,
      ),
    };
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.prompts)) {
    return {
      project:
        typeof args.project === "string"
          ? args.project
          : payload.project || "default",
      prompts: payload.prompts,
    };
  }

  throw new Error("Prompt file must be a JSON array or { project, prompts } object");
}

async function batchCommand(args) {
  if (typeof args.file !== "string") throw new Error("--file is required");
  const delayMs = Number(args["delay-ms"] ?? 5_000);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be >= 0");

  const payload = JSON.parse(await readFile(args.file, "utf8"));
  const batch = normalizePromptFile(payload, args);
  const prompts = batch.prompts
    .filter((item) => item && item.enabled !== false)
    .map((item) => (typeof item === "string" ? item : item.text))
    .filter((text) => typeof text === "string" && text.trim())
    .map((text) => text.trim());

  const config = loadConfig();
  const store = new RunStore(config);
  const session = await launchBrowserSession(config);
  let success = 0;
  let partial = 0;
  let failed = 0;
  try {
    await openDoubao(session.page, config);
    for (let index = 0; index < prompts.length; index += 1) {
      try {
        const run = await executeOne({
          page: session.page,
          store,
          config,
          prompt: prompts[index],
          project: batch.project,
        });
        if (run.status === "success") success += 1;
        else partial += 1;
      } catch (error) {
        failed += 1;
        const code = error?.normalized?.code;
        if (SESSION_BLOCKING_CODES.has(code)) {
          console.error(`Batch stopped because the Doubao session is not healthy (${code}).`);
          break;
        }
      }

      if (index < prompts.length - 1 && delayMs > 0) {
        const jitter = Math.floor(Math.random() * Math.min(1_500, delayMs * 0.3 + 1));
        await session.page.waitForTimeout(delayMs + jitter);
      }
    }
  } finally {
    await session.close();
  }

  console.log(`Batch complete: success=${success}, partial=${partial}, failed=${failed}`);
}

async function runsCommand() {
  const config = loadConfig();
  const store = new RunStore(config);
  const runs = await store.listRuns();
  const rows = runs.slice(0, 30).map((run) => ({
    id: run.id,
    project: run.project,
    status: run.status,
    citations: (run.citations || []).length,
    expected: run.expectedCitationCount,
    error: run.errorCode,
    prompt: String(run.prompt || "").slice(0, 80),
  }));
  console.table(rows);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!command || command === "help" || args.help) {
    printHelp();
    return;
  }

  if (command === "auth") await authCommand();
  else if (command === "run") await runCommand(args);
  else if (command === "batch") await batchCommand(args);
  else if (command === "runs") await runsCommand();
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
