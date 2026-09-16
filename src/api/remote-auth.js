import { loadConfig } from "../config.js";
import { launchBrowserSession } from "../browser.js";
import { inspectSession, openDoubao } from "../doubao.js";
import { markStorageStatePresent, recordAccountFailure } from "../accounts/safety.js";
import { updateAuthSessionRow } from "./service-store.js";

const runtimes = new Map();

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function publicRuntime(runtime) {
  if (!runtime) return null;
  return {
    state: runtime.state,
    last_checked_at: runtime.lastCheckedAt,
    screenshot_available: Boolean(runtime.screenshot),
    browser_active: Boolean(runtime.session),
  };
}

async function closeBrowser(runtime) {
  const session = runtime?.session;
  runtime.session = null;
  if (session) await session.close().catch(() => undefined);
}

async function finish(runtime, status, details = {}) {
  if (!runtime || runtime.finished) return;
  runtime.finished = true;
  runtime.state = status;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  await closeBrowser(runtime);
  await updateAuthSessionRow(runtime.pool, {
    id: runtime.id,
    tenantId: runtime.tenantId,
    status,
    details,
    complete: true,
  }).catch(() => undefined);
}

async function markLoginConnected(runtime) {
  await markStorageStatePresent(runtime.pool, runtime.accountKey, true, runtime.provider);
  // A successful login proves the provider session is valid, but must not erase an unrelated
  // safety cooldown/rate-limit window. Clear only manual login/session/verification blocks when
  // no active cooldown is in force.
  await runtime.pool.query(
    `UPDATE accounts
        SET status = CASE
              WHEN cooldown_until IS NOT NULL AND cooldown_until > now() THEN status
              ELSE 'healthy'
            END,
            paused_at = CASE
              WHEN cooldown_until IS NOT NULL AND cooldown_until > now() THEN paused_at
              ELSE NULL
            END,
            pause_reason = CASE
              WHEN cooldown_until IS NOT NULL AND cooldown_until > now() THEN pause_reason
              ELSE NULL
            END,
            consecutive_failures = CASE
              WHEN cooldown_until IS NOT NULL AND cooldown_until > now() THEN consecutive_failures
              ELSE 0
            END,
            last_health_status = 'healthy',
            last_health_checked_at = now(),
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [runtime.accountKey, runtime.provider],
  );
}

/**
 * Remote auth is intentionally constrained: OneGl may open the provider's ordinary login
 * surface, but it does not expose arbitrary click/type/browser-control endpoints. The product UI
 * can display screenshots (typically the provider QR/login modal) and poll auth state.
 */
async function openLoginSurface(page) {
  const state = await inspectSession(page).catch(() => ({ state: "unknown" }));
  if (state.state === "healthy") return;

  const candidates = [
    page.getByRole("button", { name: "登录", exact: true }),
    page.getByText("登录", { exact: true }),
  ];
  for (const locator of candidates) {
    try {
      const count = Math.min(await locator.count(), 5);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        await candidate.click();
        await page.waitForTimeout(800);
        return;
      }
    } catch {
      // Try the next semantic login control. Never fall back to arbitrary coordinates/selectors.
    }
  }
}

async function capture(runtime) {
  if (!runtime.session?.page || runtime.finished || runtime.polling) return;
  runtime.polling = true;
  try {
    if (Date.now() >= runtime.expiresAt) {
      await finish(runtime, "expired", { reason: "auth-session-expired" });
      return;
    }

    const page = runtime.session.page;
    runtime.screenshot = await page.screenshot({ type: "png", fullPage: false }).catch(() => runtime.screenshot);
    runtime.lastCheckedAt = new Date().toISOString();
    const state = await inspectSession(page);

    if (state.state === "healthy") {
      await runtime.session.saveAuth();
      await markLoginConnected(runtime);
      await finish(runtime, "connected", {
        provider: runtime.provider,
        account_id: runtime.externalId,
        storage_state_saved: true,
      });
      return;
    }

    if (state.state === "verification_required") {
      await recordAccountFailure(runtime.pool, {
        accountKey: runtime.accountKey,
        provider: runtime.provider,
        errorCode: "DOUBAO_VERIFICATION_REQUIRED",
      }).catch(() => undefined);
      await finish(runtime, "verification_required", {
        provider: runtime.provider,
        account_id: runtime.externalId,
        message: "Provider requires human verification. OneGl does not solve or bypass verification challenges.",
      });
      return;
    }
    if (state.state === "access_restricted") {
      await recordAccountFailure(runtime.pool, {
        accountKey: runtime.accountKey,
        provider: runtime.provider,
        errorCode: "DOUBAO_ACCESS_RESTRICTED",
      }).catch(() => undefined);
      await finish(runtime, "access_restricted", {
        provider: runtime.provider,
        account_id: runtime.externalId,
        message: "Provider reports access restriction.",
      });
      return;
    }

    runtime.state = "waiting_for_login";
    await updateAuthSessionRow(runtime.pool, {
      id: runtime.id,
      tenantId: runtime.tenantId,
      status: "waiting_for_login",
      details: {
        provider: runtime.provider,
        account_id: runtime.externalId,
        provider_state: state.state,
        screenshot_available: Boolean(runtime.screenshot),
      },
    });
  } catch (error) {
    await finish(runtime, "failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    runtime.polling = false;
  }
}

export async function startRemoteAuthSession({ pool, tenantId, authRow, account }) {
  if (runtimes.has(authRow.id)) return publicRuntime(runtimes.get(authRow.id));

  const remoteHeadless = boolEnv("ONEGL_REMOTE_AUTH_HEADLESS", true);
  const pollMs = intEnv("ONEGL_REMOTE_AUTH_POLL_MS", 1500, 500, 10000);
  const config = loadConfig({ accountKey: account.account_key, headless: remoteHeadless });
  const runtime = {
    id: authRow.id,
    pool,
    tenantId,
    accountKey: account.account_key,
    externalId: account.external_id,
    provider: account.provider,
    session: null,
    screenshot: null,
    state: "starting",
    lastCheckedAt: null,
    expiresAt: new Date(authRow.expires_at).getTime(),
    timer: null,
    polling: false,
    finished: false,
  };
  runtimes.set(runtime.id, runtime);
  await updateAuthSessionRow(pool, {
    id: runtime.id,
    tenantId,
    status: "starting",
    details: { provider: runtime.provider, account_id: runtime.externalId },
  });

  try {
    runtime.session = await launchBrowserSession(config, { ignoreStoredAuth: true });
    await openDoubao(runtime.session.page, config);
    await openLoginSurface(runtime.session.page);
    await capture(runtime);
    if (!runtime.finished) {
      runtime.timer = setInterval(() => capture(runtime), pollMs);
      runtime.timer.unref?.();
    }
  } catch (error) {
    await finish(runtime, "failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return publicRuntime(runtime);
}

export function remoteAuthRuntime(id) {
  return publicRuntime(runtimes.get(id));
}

export function remoteAuthScreenshot(id) {
  return runtimes.get(id)?.screenshot ?? null;
}

export async function cancelRemoteAuthSession({ pool, tenantId, id }) {
  const runtime = runtimes.get(id);
  if (runtime && runtime.tenantId === tenantId) {
    await finish(runtime, "cancelled", { reason: "cancelled-by-client" });
    return true;
  }
  const row = await updateAuthSessionRow(pool, {
    id,
    tenantId,
    status: "cancelled",
    details: { reason: "cancelled-by-client" },
    complete: true,
  });
  return Boolean(row);
}

export async function shutdownRemoteAuthSessions() {
  await Promise.all([...runtimes.values()].map(async (runtime) => {
    if (!runtime.finished) await finish(runtime, "cancelled", { reason: "api-server-shutdown" });
  }));
}
