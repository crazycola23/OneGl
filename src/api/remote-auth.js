import crypto from "node:crypto";
import os from "node:os";

import { loadConfig } from "../config.js";
import { launchBrowserSession } from "../browser.js";
import { inspectSession, openDoubao } from "../doubao.js";
import { markStorageStatePresent, recordAccountFailure } from "../accounts/safety.js";
import { updateAuthSessionRow } from "./service-store.js";

const runtimes = new Map();
const RUNTIME_OWNER = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

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

function ownerTimeoutMs() {
  return intEnv("ONEGL_REMOTE_AUTH_OWNER_TIMEOUT_MS", 30_000, 10_000, 300_000);
}

function publicRuntime(runtime) {
  if (!runtime) return null;
  return {
    state: runtime.state,
    last_checked_at: runtime.lastCheckedAt,
    screenshot_available: Boolean(runtime.screenshot),
    browser_active: Boolean(runtime.session) && !runtime.finished,
  };
}

export function persistedRemoteAuthRuntime(row) {
  if (!row) return null;
  const heartbeatAt = row.runtime_heartbeat_at ? new Date(row.runtime_heartbeat_at).getTime() : 0;
  const active = Boolean(
    row.runtime_owner &&
    !row.completed_at &&
    heartbeatAt &&
    Date.now() - heartbeatAt <= ownerTimeoutMs(),
  );
  return {
    state: row.status,
    last_checked_at: row.runtime_heartbeat_at ?? row.updated_at ?? null,
    screenshot_available: Boolean(row.screenshot_available),
    browser_active: active,
  };
}

async function closeBrowser(runtime) {
  const session = runtime?.session;
  runtime.session = null;
  if (session) await session.close().catch(() => undefined);
}

async function claimRuntime(runtime) {
  const timeoutSeconds = Math.ceil(ownerTimeoutMs() / 1000);
  const { rows } = await runtime.pool.query(
    `UPDATE service_auth_sessions
        SET runtime_owner = $3,
            runtime_heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
        AND completed_at IS NULL
        AND expires_at > now()
        AND (
          runtime_owner IS NULL
          OR runtime_owner = $3
          OR runtime_heartbeat_at IS NULL
          OR runtime_heartbeat_at < now() - ($4 * interval '1 second')
        )
      RETURNING id, status, cancel_requested_at, expires_at`,
    [runtime.id, runtime.tenantId, RUNTIME_OWNER, timeoutSeconds],
  );
  return rows[0] ?? null;
}

async function touchRuntime(runtime, { status = null, details = null, screenshot = null } = {}) {
  const { rows } = await runtime.pool.query(
    `UPDATE service_auth_sessions
        SET runtime_heartbeat_at = now(),
            updated_at = now(),
            status = COALESCE($4, status),
            state_details = CASE WHEN $5::jsonb IS NULL THEN state_details ELSE $5::jsonb END,
            screenshot = CASE WHEN $6::bytea IS NULL THEN screenshot ELSE $6::bytea END,
            screenshot_at = CASE WHEN $6::bytea IS NULL THEN screenshot_at ELSE now() END
      WHERE id = $1 AND tenant_id = $2
        AND runtime_owner = $3
        AND completed_at IS NULL
      RETURNING cancel_requested_at, expires_at`,
    [
      runtime.id,
      runtime.tenantId,
      RUNTIME_OWNER,
      status,
      details == null ? null : JSON.stringify(details),
      screenshot,
    ],
  );
  return rows[0] ?? null;
}

async function finish(runtime, status, details = {}) {
  if (!runtime || runtime.finished) return;
  runtime.finished = true;
  runtime.state = status;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  await closeBrowser(runtime);
  await runtime.pool.query(
    `UPDATE service_auth_sessions
        SET status = $4,
            state_details = $5::jsonb,
            updated_at = now(),
            completed_at = COALESCE(completed_at, now()),
            runtime_heartbeat_at = now(),
            runtime_owner = NULL
      WHERE id = $1 AND tenant_id = $2
        AND (runtime_owner = $3 OR runtime_owner IS NULL)`,
    [runtime.id, runtime.tenantId, RUNTIME_OWNER, status, JSON.stringify(details ?? {})],
  ).catch(() => undefined);
}

async function abandon(runtime) {
  if (!runtime || runtime.finished) return;
  runtime.finished = true;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  await closeBrowser(runtime);
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
    const heartbeat = await touchRuntime(runtime);
    if (!heartbeat) {
      // Ownership was lost or another node marked the session terminal. Close locally and never
      // overwrite the durable state owned by the other node.
      await abandon(runtime);
      return;
    }
    if (heartbeat.cancel_requested_at) {
      await finish(runtime, "cancelled", { reason: "cancelled-by-client" });
      return;
    }
    if (Date.now() >= runtime.expiresAt) {
      await finish(runtime, "expired", { reason: "auth-session-expired" });
      return;
    }

    const page = runtime.session.page;
    runtime.screenshot = await page.screenshot({ type: "png", fullPage: false }).catch(() => runtime.screenshot);
    runtime.lastCheckedAt = new Date().toISOString();
    const persisted = await touchRuntime(runtime, { screenshot: runtime.screenshot });
    if (!persisted) {
      await abandon(runtime);
      return;
    }
    if (persisted.cancel_requested_at) {
      await finish(runtime, "cancelled", { reason: "cancelled-by-client" });
      return;
    }

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
    await touchRuntime(runtime, {
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
  const claimed = await claimRuntime(runtime);
  if (!claimed) {
    return {
      state: "owned_elsewhere",
      last_checked_at: null,
      screenshot_available: false,
      browser_active: false,
    };
  }

  runtimes.set(runtime.id, runtime);
  await touchRuntime(runtime, {
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

export async function persistedRemoteAuthScreenshot(pool, tenantId, id) {
  const { rows } = await pool.query(
    `SELECT screenshot
       FROM service_auth_sessions
      WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0]?.screenshot ?? null;
}

export async function cancelRemoteAuthSession({ pool, tenantId, id }) {
  const { rows } = await pool.query(
    `UPDATE service_auth_sessions
        SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
            status = CASE WHEN completed_at IS NULL THEN 'cancelled' ELSE status END,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, runtime_owner`,
    [id, tenantId],
  );
  if (!rows[0]) return false;

  const runtime = runtimes.get(id);
  if (runtime && runtime.tenantId === tenantId) {
    await finish(runtime, "cancelled", { reason: "cancelled-by-client" });
  }
  return true;
}

export async function shutdownRemoteAuthSessions() {
  await Promise.all([...runtimes.values()].map(async (runtime) => {
    if (!runtime.finished) await finish(runtime, "failed", { reason: "runtime-owner-shutdown" });
  }));
}
