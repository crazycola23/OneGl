import crypto from "node:crypto";
import os from "node:os";

import { loadConfig } from "../config.js";
import { launchBrowserSession } from "../browser.js";
import { inspectSession, openDoubao } from "../doubao.js";
import { markStorageStatePresent, recordAccountFailure } from "../accounts/safety.js";

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
  runtime.screenshot = null;
  await runtime.pool.query(
    `UPDATE service_auth_sessions
        SET status = $4,
            state_details = $5::jsonb,
            updated_at = now(),
            completed_at = COALESCE(completed_at, now()),
            runtime_heartbeat_at = now(),
            runtime_owner = NULL,
            screenshot = NULL,
            screenshot_at = NULL
      WHERE id = $1 AND tenant_id = $2
        AND (runtime_owner = $3 OR runtime_owner IS NULL)`,
    [runtime.id, runtime.tenantId, RUNTIME_OWNER, status, JSON.stringify(details ?? {})],
  ).catch(() => undefined);
  runtimes.delete(runtime.id);
}

async function abandon(runtime) {
  if (!runtime || runtime.finished) return;
  runtime.finished = true;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  await closeBrowser(runtime);
  runtime.screenshot = null;
  runtimes.delete(runtime.id);
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

/**
 * 判断登录浮层（含二维码）是否已经真正出现。
 *
 * ★ 为什么必须有这个判据（2026-09-20 实测）：
 * 只「点了登录按钮」不等于「二维码已经可见」。真实浏览器实测：
 * 点击后浮层文本为「使用豆包或飞书账号登录 / 手机号登录 / … / 打开 豆包 / 飞书 App 扫码登录」，
 * 二维码容器是 `div[class*="qrcode"]`（实测 class = `qrcode-DeN5Ny`，164x162）。
 * 若只点一次就 return，camoufox 冷启动或浮层动画未完成时会出现
 * 「会话仍在 waiting_for_login，但截图里没有二维码」，用户无从扫码。
 *
 * 判据只看「浮层存在 + 二维码容器可见 + 提示扫码文案」，不依赖 hash 后缀类名。
 */
async function loginSurfaceVisible(page) {
  return page
    .evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const overlay = [
        ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .semi-modal, .modal'),
      ].filter(visible);
      const overlayText = overlay
        .map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " "))
        .join(" ");
      const overlayPresent = overlay.length > 0 && /登录|扫码/.test(overlayText);

      // 二维码容器：class 带 qrcode/qr-code（后缀是构建 hash，不能写死）+ 尺寸足够大。
      const qr = [
        ...document.querySelectorAll(
          '[class*="qrcode"], [class*="qr-code"], [class*="QRCode"], canvas, svg',
        ),
      ].some((el) => {
        if (!visible(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 80 && rect.height >= 80;
      });

      const hint = /打开.{0,10}(豆包|飞书).{0,10}(App)?\s*扫码|扫码登录|二维码/.test(overlayText);

      // ★ 二维码过期探测（2026-09-20 实测）。
      //
      // 豆包的扫码二维码有效期很短，过期后二维码区域会被替换为一张「二维码失效 /
      // 点击刷新」占位图 —— 它仍然是一个 80x80 以上的可见容器，所以单看 `qr`
      // 判据会把「失效」误判为「可用」。用户点进 GEO 页面时若码已过期，就只能
      // 看到这张不会自己更新的占位图，无法完成扫码。
      //
      // 过期文案由豆包前端渲染在二维码容器内，用文本判定即可，无需依赖构建 hash 类名。
      const expired = /二维码失效|二维码已过期|已失效.{0,4}点击刷新|点击刷新/.test(overlayText);
      return { overlayPresent, qr, hint, expired, ok: overlayPresent && qr && !expired };
    })
    .catch(() => ({ overlayPresent: false, qr: false, hint: false, expired: false, ok: false }));
}

/**
 * 二维码过期时点击刷新，让浮层重新生成一张可扫的码。
 *
 * 为什么需要这一步：`capture()` 的业务是「只要没登录就一直截图给用户看」。
 * 若码过期后不刷新，用户看到的永远是那张「点击刷新」占位图，
 * 表现为「二维码一直显示失效」。刷新是幂等的安全操作（只触发前端重新请求二维码），
 * 因此任何失败都只记录、不打断会话。
 *
 * 返回 true 表示确实执行过一次刷新点击。
 */
async function refreshQrIfExpired(page) {
  const probe = await loginSurfaceVisible(page);
  if (!probe.overlayPresent || !probe.expired) return false;

  // 候选一：豆包把整块失效占位图做成了可点区域（实测文案「点击刷新」在容器内）。
  // 候选二：显式的刷新按钮/链接。
  const candidates = [
    page.getByText("点击刷新", { exact: false }),
    page.getByText("刷新", { exact: false }),
    page.getByRole("button", { name: /刷新/ }),
  ];

  for (const locator of candidates) {
    let count = 0;
    try {
      count = Math.min(await locator.count(), 5);
    } catch {
      continue;
    }
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      // 与 openLoginSurface 同理：camoufox 下必须绕过稳定性预检。
      try {
        await candidate.click({ force: true, timeout: 5_000 });
        return true;
      } catch {
        try {
          await candidate.dispatchEvent("click", undefined, { timeout: 5_000 });
          return true;
        } catch {
          /* 试下一个候选 */
        }
      }
    }
  }
  return false;
}

/**
 * 打开登录浮层，并等到二维码真正渲染出来。
 *
 * 背景（2026-09-20 实测）：此前实现「点一次候选按钮就 return」，实测会在三种情况下失效：
 *   1. 点击命中的是不可用/被遮挡的节点，浮层未打开；
 *   2. 浮层已打开但二维码尚未渲染，截图里看不到码；
 *   3. ★ camoufox（生产默认引擎）下 `locator.click()` 持续超时 —— 豆包登录按钮的
 *      class 带自定义动画（`samantha-button-…`），Playwright 的「稳定性 + 可命中性」
 *      预检永远等不过去，5s 后抛 Timeout，浮层自然打不开。
 *      实测四种策略对比：
 *        locator.click()            → 超时，二维码不出现
 *        locator.click({force:true}) → ✅ 浮层 + 二维码（div[class*="qrcode"] 164x162）
 *        page.mouse.click(x, y)     → 点击落空，无浮层
 *        dispatchEvent("click")     → ✅ 浮层 + 二维码
 *      因此这里以 `click({ force: true })` 为主、`dispatchEvent("click")` 为兜底。
 */
async function openLoginSurface(page) {
  const state = await inspectSession(page).catch(() => ({ state: "unknown" }));
  if (state.state === "healthy") return;

  const candidates = [
    page.getByRole("button", { name: "登录", exact: true }),
    page.getByText("登录", { exact: true }),
  ];
  // 点击后最多轮询 15 次：浮层动画 + 二维码请求都需要时间。
  // 用「次数」而非墙钟兜底，避免 waitForTimeout 被替身实现为瞬时返回时死循环。
  const MAX_PROBES = 15;

  for (const locator of candidates) {
    let count = 0;
    try {
      count = Math.min(await locator.count(), 5);
    } catch {
      continue;
    }
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;

      // ① 首选 force click：跳过稳定性/可命中性预检（camoufox 下必需）。
      let clicked = false;
      try {
        await candidate.click({ force: true, timeout: 5_000 });
        clicked = true;
      } catch {
        // ② 兜底：直接派发 DOM click 事件。
        try {
          await candidate.dispatchEvent("click", undefined, { timeout: 5_000 });
          clicked = true;
        } catch {
          clicked = false;
        }
      }
      if (!clicked) continue;

      let probe = { ok: false, overlayPresent: false };
      for (let attempt = 0; attempt < MAX_PROBES; attempt += 1) {
        await page.waitForTimeout(400);
        probe = await loginSurfaceVisible(page);
        if (probe.ok) return;
      }
      // 浮层打开了但二维码还没出来：再多给一点时间，不让调用方空等。
      if (probe.overlayPresent) {
        await page.waitForTimeout(2_000);
        const settled = await loginSurfaceVisible(page);
        if (settled.ok) return;
      }
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

    // ★ 二维码过期自愈（2026-09-20）。
    //
    // 放在截图之前：豆包的扫码码有效期很短，过期后二维码区域会变成一张
    // 「二维码失效 / 点击刷新」占位图。若不刷新，GEO 前端拿到的永远是一张
    // 不可扫的图（前端只是 <img> 展示，用户点不动），表现为流程走不通。
    // 先刷新再截图，用户看到的就是刚生成的新码。
    //
    // 仅在「浮层已开且探到过期文案」时才点击；探测与点击失败都不打断会话。
    const refreshed = await refreshQrIfExpired(page).catch(() => false);
    if (refreshed) {
      // 给前端重新请求并渲染二维码留出时间，否则截到的仍是旧占位图。
      await page.waitForTimeout(1_500);
      runtime.qrRefreshedAt = new Date().toISOString();
    }

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
            updated_at = now(),
            screenshot = NULL,
            screenshot_at = NULL
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
