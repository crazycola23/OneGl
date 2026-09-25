/**
 * 账号安全层。
 *
 * 目标不是绕过平台风控，而是避免自动化脚本在账号异常时持续撞击平台：
 * 达到条件就停下来等人工处理，而不是无限重试。
 *
 * 这里不做任何验证码识别、行为伪装或限制规避。
 */
import { isCredentialFreeSurface } from "../providers/index.js";

function intEnv(name, fallback, min = 1) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} 必须是不小于 ${min} 的整数`);
  }
  return parsed;
}

/**
 * 同一个环境变量整数解析，供 provider profile 复用它自己的旋钮。
 *
 * 导出而不是各写一份：profile 里那些「实测值 + 可被运维覆盖」的数字如果各自解析，就会出现
 * 某处接受 0、某处拒绝 0 的分歧，而分歧的表现形式是「配置看着生效了、实际没生效」。
 */
export function intEnvValue(name, fallback, min = 1) {
  return intEnv(name, fallback, min);
}

/**
 * 同上的整数解析，但「未设置」返回 null 而不是 fallback。
 *
 * 用来表达「跟随另一个值」而不是「取这个默认值」—— 例如匿名面的槽位数：未设置时应当继承
 * accountSlots，设置了才独立。若用 intEnv 配一个默认值，就分不出「运维明确设成了 1」和
 * 「运维没管，应该跟着全局走」这两种情况，而它们的语义完全不同。
 */
function optionalIntEnv(name, min = 1) {
  const raw = process.env[name];
  if (raw == null || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} 必须是不小于 ${min} 的整数`);
  }
  return parsed;
}

export function safetyConfig() {
  const minDelayMs = intEnv("ONEGL_MIN_DELAY_MS", 30_000, 0);
  const maxDelayMs = intEnv("ONEGL_MAX_DELAY_MS", 90_000, 0);
  if (maxDelayMs < minDelayMs) {
    throw new Error("ONEGL_MAX_DELAY_MS 不能小于 ONEGL_MIN_DELAY_MS");
  }
  return {
    minDelayMs,
    maxDelayMs,
    minInterRunMs: intEnv("ONEGL_MIN_INTER_RUN_SECONDS", 45, 0) * 1_000,
    accountHourlyLimit: intEnv("ONEGL_ACCOUNT_HOURLY_LIMIT", 10, 1),
    accountDailyLimit: intEnv("ONEGL_ACCOUNT_DAILY_LIMIT", 40),
    maxConsecutiveFailures: intEnv("ONEGL_MAX_CONSECUTIVE_FAILURES", 3),
    cooldownMinutes: intEnv("ONEGL_ACCOUNT_COOLDOWN_MINUTES", 60, 1),
    rateLimitCooldownMinutes: intEnv("ONEGL_RATE_LIMIT_COOLDOWN_MINUTES", 180, 1),
    accountParallelism: intEnv("ONEGL_ACCOUNT_PARALLELISM", 1),
    // Prompts served per browser window before the window is replaced. 0 keeps one window for
    // the whole session, which is how collection worked before this knob existed - so the
    // default must stay 0. A provider that needs isolation declares it on its own profile
    // (quota.promptsPerWindow) instead of changing everyone else's behaviour.
    roundPromptLimit: intEnv("ONEGL_ROUND_PROMPT_LIMIT", 0, 0),
    // Prompts served per *browser launch* before the whole browser is torn down and relaunched,
    // which is the only thing that yields a new device fingerprint: Camoufox derives it inside
    // launch_options(), so a context rotation cannot reach it. 0 keeps the original behaviour of
    // one browser process for the whole worker lifetime. The counter resets on every relaunch, so
    // N means "relaunch every N prompts", never "stop after N prompts".
    windowResetEvery: intEnv("ONEGL_WINDOW_RESET_EVERY", 0, 0),
    // Optional scope for the relaunch above. Empty means "every provider", which is the only
    // value that was ever available before this knob; a non-empty list keeps a relaunch policy
    // aimed at one platform from also cold-starting the browser for the others, where it would
    // cost a launch per N prompts and change a working session's device identity for no reason.
    windowResetProviders: strListEnv("ONEGL_WINDOW_RESET_PROVIDERS"),
    // 同一个账号允许同时跑几个浏览器 —— **不分有凭证还是匿名**，统一由这个值决定。
    //
    // 与 accountParallelism 的区别是作用维度不同：那个是「同时跑几个**账号**」，跨账号生效，
    // 每个账号各拿一个全局槽位；这个是「同一个账号内同时跑几个**浏览器**」，每个槽位持有
    // 独立的浏览器进程、页面和指纹。
    //
    // ⚠️ 对**有凭证**的账号开这个开关是有代价的，而且是刻意承担的：账号级 advisory lock
    // 原本把同一登录态串行化，防止它被并发击穿（平台看到同一账号多设备同时提问，风控会收紧）。
    // slots > 1 时那把锁按槽位放行（见 distributed-lock.js），保护随之让位给吞吐。
    // 匿名面没有这个顾虑：它没有可被击穿的登录态。
    //
    // 默认 1：与改造前逐字一致。要只给匿名面开并发、让登录态账号维持原保护，用下面的覆盖项。
    accountSlots: intEnv("ONEGL_ACCOUNT_SLOTS", 1),
    // 同一个账号两次「提交提问」之间的最小间隔。
    //
    // 这是并发挂起的**预防**措施，与 worker.js 里的降级兜底（事后止损）配套。实测（2026-09-24
    // #66）：两个槽位同时 job-start 并同时跑到预算耗尽，而单槽位下同一个任务 268–388 秒正常完成
    // —— 平台对「同一时刻两个匿名请求」的响应被挂起，而不是它变慢了。
    //
    // 所以触发条件是「提交时刻撞车」，不是「并发本身」。把提交错开就能同时保住并发收益和不被挂起：
    // 本值远小于单条耗时（约 270s），错开造成的等待不改变整体吞吐量级，但它保证任何两个请求
    // 不会在同一瞬间到达平台。
    //
    // 默认 0（关闭）。设成 0 时行为与改造前逐字一致。
    submitIntervalMs: intEnv("ONEGL_SUBMIT_INTERVAL_MS", 0, 0),
    // 匿名面（requiresStoredAuth === false）的槽位覆盖值。未设置时跟随 accountSlots。
    //
    // 存在的理由是两面的风险不对称：匿名面多开只影响同一个出口 IP 上的访客数，而有凭证的
    // 账号多开是拿账号本身去试平台风控。合成一个值时，想给千问加速就必须同时把豆包也放开，
    // 而那个决定需要单独的证据。
    anonymousAccountSlots: optionalIntEnv("ONEGL_ANONYMOUS_ACCOUNT_SLOTS", 1),
  };
}

function strListEnv(name) {
  return String(process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Rotation resets conversation state, not device identity: the new window inherits the
 * account's cookies and Camoufox fixes its fingerprint at launch, so the platform still sees
 * one machine returning. The provider's declared value wins because the requirement is a
 * property of how that platform scopes a conversation, not of the operator's machine.
 */
export function windowPromptLimit(profileValue, fallback) {
  return Number.isInteger(profileValue) && profileValue > 0 ? profileValue : fallback;
}

export function shouldRotateContext(promptsSoFar, limit) {
  if (!Number.isInteger(limit) || limit <= 0) return false;
  return Number(promptsSoFar) >= limit;
}

/**
 * Whether the *browser process* has to be replaced, not merely its context.
 *
 * Deliberately a separate decision from `shouldRotateContext` because the two cost very
 * different things: a context rotation drops conversation state for free, while this one drops
 * the device identity and pays a full Camoufox cold start plus the orphan-tree reap. A surface
 * pinned to one prompt per window would otherwise relaunch the browser on every single prompt,
 * which is exactly the churn the reaping notes in `browser.js` warn about. The caller resets the
 * counter after a successful relaunch, so `every = 2` reads as "relaunch every 2 prompts".
 */
export function shouldRotateIdentity(promptsSoFar, every, { provider = null, providers = [] } = {}) {
  if (!Number.isInteger(every) || every <= 0) return false;
  // An empty allowlist is "all providers": that is what the knob meant before the scope existed,
  // and it keeps a deploy that already set the number from silently stopping mid-change.
  if (Array.isArray(providers) && providers.length > 0) {
    if (provider == null || !providers.includes(String(provider).toLowerCase())) return false;
  }
  return Number(promptsSoFar) >= every;
}

/**
 * 身份轮换后，剩下多少个提问才轮到下一次。
 *
 * 存在的理由是「每 N 次提问重启一次浏览器」这句语义会踩到一个进位问题：判定发生在**提问之前**，
 * 而计数发生在提问之后。若重启时把计数直接清零，那么 N=2 的实际周期会变成 3 次
 * （0→1→2 触发→清零→0…）。扣掉本次这个提问，周期才等于声明的 N。
 *
 * @param {number} promptsSoFar 触发本次重启时累计的提问数
 * @param {number} every 配置的每 N 次
 * @returns {number} 新会话的起始计数
 */
export function identityPromptsAfterRelaunch(promptsSoFar, every) {
  const consumed = Number(promptsSoFar) % Number(every);
  return Number.isFinite(consumed) ? consumed : 0;
}

/**
 * 这个账号在**当前批次内、当前并发槽位内**已经服务过多少次提问 —— 身份轮换的计数从这里读。
 *
 * 为什么不用内存计数：worker 进程或容器每重启一次，内存计数就归零，于是「每 2 次提问换一次
 * 指纹」实际变成「每 3 次」——每次重启后第 1、2 条共用一个身份，第 3 条才换。这个偏差不会
 * 报错，只会让指纹与提问的对应关系悄悄漂移，而指纹轮换正是为了打断这种对应关系才存在的。
 *
 * 为什么按批次而不是按账号累计：需求是「一次对话里每两次重置一次」。跨批次累计会让同一账号
 * 重跑同一个批次时落在不同的轮换位上（上一轮 100 条是偶数，下一轮就从 0 开始，看上去对；
 * 但只要中途少跑一条，节奏就整体错开一格）。按批次计数时每个批次都是从头对齐的。
 *
 * 为什么还要按槽位分：无凭证面可以并排跑 N 个浏览器（ONEGL_ACCOUNT_SLOTS），每个槽位持有
 * 自己的指纹。若 N 个槽位共用一个全局计数，它们会在同一个位置一起触发轮换 —— 等于把 N 个
 * 浏览器同时重启，既浪费又让「槽位」这个隔离失去意义。槽位由 selectionIndex 对槽位数取模
 * 划分，所以第 0/3/6… 条归槽位 0，第 1/4/7… 条归槽位 1，与调度顺序无关。
 *
 * run 的写入是 `ON CONFLICT (local_run_id) DO UPDATE` 的 upsert，重试同一格不会留下重复行，
 * 所以 count(*) 就是「服务过的提问数」，不需要去重。
 *
 * @param {object} options
 * @param {number} options.slot 并发槽位号；0 或不传即「不分槽位」（改造前的行为）
 * @returns {Promise<number>} 该槽位已完成的提问数；拿不到批次时退化为 0
 */
export async function promptCountForBatch(pool, { batchId, accountKey, provider, slot = 0 }) {
  if (!pool || !Number.isFinite(Number(batchId))) return 0;
  const totalSlots = Math.max(1, Math.floor(Number(safetyConfig().accountSlots) || 1));
  const slotIndex = Number.isInteger(slot) && slot >= 0 && slot < totalSlots ? slot : 0;
  // 单槽位时不加槽位条件：存量行（包括迁移前写入的）request_slot 都是 0，但这里的意图是
  // 「没开并发就等于改造前的行为」，所以直接退化成原来的查询，不依赖那个默认值。
  const { rows } = totalSlots > 1
    ? await pool.query(
        `SELECT count(*)::integer AS served
           FROM runs
          WHERE sampling_batch_id = $1 AND account_key = $2 AND provider = $3
            AND request_slot = $4`,
        [batchId, accountKey, provider, slotIndex],
      )
    : await pool.query(
        `SELECT count(*)::integer AS served
           FROM runs
          WHERE sampling_batch_id = $1 AND account_key = $2 AND provider = $3`,
        [batchId, accountKey, provider],
      );
  return Number(rows[0]?.served) || 0;
}

export function randomDelayMs({ minDelayMs, maxDelayMs }) {
  if (maxDelayMs <= minDelayMs) return minDelayMs;
  return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
}

export const ACCOUNT_BLOCKING_CODES = {
  DOUBAO_LOGIN_REQUIRED: {
    status: "login_required",
    manual: true,
    message: "豆包未登录，需要人工重新执行 npm run auth",
  },
  DOUBAO_SESSION_EXPIRED: {
    status: "session_expired",
    manual: true,
    message: "登录态已失效，需要人工重新执行 npm run auth",
  },
  DOUBAO_VERIFICATION_REQUIRED: {
    status: "verification_required",
    manual: true,
    message: "触发人机验证，已停止自动运行，需要人工在浏览器中处理",
  },
  DOUBAO_ACCESS_RESTRICTED: {
    status: "access_restricted",
    manual: true,
    message: "账号被限制访问，已停止自动运行",
  },
  RATE_LIMITED: {
    status: "rate_limited",
    manual: false,
    message: "触发频率限制，进入长冷却",
  },
};

// Failures in OneGl's own persistence/queue/storage layers are not observations about
// the provider account. They must never increment provider consecutive_failures or put
// a healthy Doubao account into cooldown.
export const INFRASTRUCTURE_ERROR_CODES = new Set([
  "DATABASE_ERROR",
  "REDIS_ERROR",
  "STORAGE_ERROR",
]);

export const RETRYABLE_CODES = new Set([
  "DOUBAO_TIMEOUT",
  "NETWORK_ERROR",
  "DOUBAO_CONVERSATION_RESET_FAILED",
  // 「发送被主动拦下」与「preflight 就没过」这两类，提问根本没到达平台，
  // 再给一次机会是安全的 —— 而在此之前它们不在这个集合里，于是**永远不会有第二次机会**：
  // 实测批次 69 的 50 条里有 22 条属于这两类（15 条输入校验失败 + 7 条 preflight 失败），
  // 全部被直接判死。
  "DOUBAO_SUBMISSION_FAILED",
  "PAGE_CHANGED",
]);

/**
 * 同一个错误码下**可能存在两种截然不同的情况**，这类必须要求显式证据才能重试。
 *
 * `DOUBAO_SUBMISSION_FAILED` 就是例子：它既覆盖「输入校验没过、发送被拦下」（没提交），
 * 也覆盖「send 动作已触发但页面没确认提交」（**可能已提交**，重试就是重复提问）。
 * 所以不能按错误码一刀切，只能看抛出方有没有写 `promptSubmitted: false` ——
 * doubao.js 里前者带这一位，后者不带。
 */
export const RESUBMIT_UNSAFE_CODES = new Set([
  "DOUBAO_TIMEOUT",
  "NETWORK_ERROR",
  "DOUBAO_SUBMISSION_FAILED",
  "PAGE_CHANGED",
]);

export function isRetryable(code) {
  return RETRYABLE_CODES.has(code);
}

export function canRetryOutcome(code, details = null) {
  if (!RETRYABLE_CODES.has(code)) return false;
  if (!RESUBMIT_UNSAFE_CODES.has(code)) return true;
  return details?.promptSubmitted === false;
}

export function isBlocking(code) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_BLOCKING_CODES, code);
}

export const DEFAULT_ACCOUNT_TIME_ZONE = "Asia/Shanghai";

export function accountTimeZone() {
  const raw = process.env.ONEGL_ACCOUNT_TIMEZONE;
  const value = raw == null || String(raw).trim() === "" ? DEFAULT_ACCOUNT_TIME_ZONE : String(raw).trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
  } catch {
    throw new Error(
      `ONEGL_ACCOUNT_TIMEZONE ${JSON.stringify(value)} 不是有效的 IANA 时区，例如 Asia/Shanghai`,
    );
  }
  return value;
}

export function accountDayKey(now = new Date(), timeZone = accountTimeZone()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function nextAccountDayStart(now = new Date(), timeZone = accountTimeZone()) {
  const offset = timeZoneOffsetMs(now, timeZone);
  const shifted = new Date(now.getTime() + offset);
  const nextMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return new Date(nextMidnight - offset);
}

export function dateKeyOf(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return matched ? matched[1] : null;
}

export const AVAILABILITY = Object.freeze({
  AVAILABLE: "available",
  TEMPORARY: "temporary",
  PERMANENT: "permanent",
});

/**
 * `pacing`/`burst` carry a provider's measured per-window allowance: how many prompts the
 * surface gives before it stops answering (`pacing.prompts`) and how long it then needs quiet
 * (`pacing.pauseMs`), together with what the account has already spent in that window
 * (`burst.runsInWindow` / `burst.newestRunAt`). Null means no burst limit has been measured.
 */
export function classifyAccountState(state, { config = safetyConfig(), now = new Date(), pacing = null, burst = null } = {}) {
  if (!state) return { kind: AVAILABILITY.AVAILABLE, reason: null, retryAt: null };

  if (!state.enabled) {
    return { kind: AVAILABILITY.PERMANENT, reason: "账号已被禁用", retryAt: null };
  }

  // A measured per-window allowance is checked before the credential-free exemption below,
  // because the two answer different questions. That exemption exists because nothing in this
  // file protects an account that cannot be blocked - and this is not about the account. It is
  // the platform stating it has stopped answering, and the prompt that trips it is already
  // submitted and therefore lost. Waiting afterwards is too late; the burst has to stop early.
  if (pacing && burst) {
    const used = Number(burst.runsInWindow) || 0;
    const newest = burst.newestRunAt ? new Date(burst.newestRunAt) : null;
    if (used >= pacing.prompts && newest) {
      const retryAt = new Date(newest.getTime() + pacing.pauseMs);
      if (retryAt > now) {
        return {
          kind: AVAILABILITY.TEMPORARY,
          reason: `平台每轮只给 ${pacing.prompts} 条，本轮已用完，静置到 ${retryAt.toLocaleString("zh-CN")}`,
          retryAt,
          // Marks a wait that is expected to resolve on its own, so the worker does not spend
          // the budget meant for an account that is stuck: a paced run needs one wait per cycle
          // and would otherwise be skipped as "unavailable too long" partway through.
          paced: true,
        };
      }
    }
  }

  // A surface with no credential behind it cannot be burned, so nothing here protects anything:
  // the caps, the spacing and the failure cooldown exist to keep a *real* account from being
  // blocked by the platform. Only the operator's enabled flag still gates such a lane (and a
  // manual pause is expressed by disabling it).
  if (isCredentialFreeSurface(state.provider)) {
    return { kind: AVAILABILITY.AVAILABLE, reason: null, retryAt: null };
  }

  if (state.paused_at && !state.cooldown_until) {
    return {
      kind: AVAILABILITY.PERMANENT,
      reason: state.pause_reason ?? "账号已暂停",
      retryAt: null,
    };
  }

  const cooldownUntil = state.cooldown_until ? new Date(state.cooldown_until) : null;
  if (cooldownUntil && cooldownUntil > now) {
    return {
      kind: AVAILABILITY.TEMPORARY,
      reason: `冷却中，至 ${cooldownUntil.toLocaleString("zh-CN")}`,
      retryAt: cooldownUntil,
    };
  }

  const today = accountDayKey(now);
  const runsToday =
    dateKeyOf(state.runs_today_date) === today ? Number(state.runs_today) || 0 : 0;
  if (runsToday >= config.accountDailyLimit) {
    return {
      kind: AVAILABILITY.TEMPORARY,
      reason: `已达每日上限 ${config.accountDailyLimit} 次`,
      retryAt: nextAccountDayStart(now),
    };
  }

  const minInterRunMs = Number(config.minInterRunMs ?? 0);
  const lastRunAt = state.last_run_at ? new Date(state.last_run_at) : null;
  if (lastRunAt && minInterRunMs > 0) {
    const retryAt = new Date(lastRunAt.getTime() + minInterRunMs);
    if (retryAt > now) {
      return {
        kind: AVAILABILITY.TEMPORARY,
        reason: `距离上次运行过近，至少间隔 ${Math.ceil(minInterRunMs / 1000)} 秒`,
        retryAt,
      };
    }
  }

  const hourlyLimit = Number(config.accountHourlyLimit ?? Number.POSITIVE_INFINITY);
  const runsLastHour = Number(state.runs_last_hour ?? 0);
  if (Number.isFinite(hourlyLimit) && runsLastHour >= hourlyLimit) {
    const oldest = state.hour_window_oldest ? new Date(state.hour_window_oldest) : now;
    const retryAt = new Date(oldest.getTime() + 60 * 60_000 + 1_000);
    return {
      kind: AVAILABILITY.TEMPORARY,
      reason: `已达每小时上限 ${hourlyLimit} 次`,
      retryAt: retryAt > now ? retryAt : new Date(now.getTime() + 60_000),
    };
  }

  return { kind: AVAILABILITY.AVAILABLE, reason: null, retryAt: null };
}

const ENSURE_ACCOUNT = `
  INSERT INTO accounts (account_key, provider)
  VALUES ($1, $2)
  ON CONFLICT (provider, account_key) DO UPDATE SET updated_at = now()
  RETURNING id
`;

export async function ensureAccountRow(pool, accountKey, provider = "doubao") {
  await pool.query(ENSURE_ACCOUNT, [accountKey, provider]);
}

export async function getAccountState(pool, accountKey, provider = "doubao") {
  const { rows } = await pool.query(
    `SELECT a.account_key, a.provider, a.enabled, a.status, a.last_run_at,
            a.runs_today, a.runs_today_date, a.consecutive_failures, a.cooldown_until,
            a.paused_at, a.pause_reason, a.last_error_code, a.last_health_status,
            a.last_health_checked_at, a.storage_state_present,
            COALESCE((
              SELECT count(*)::integer
                FROM runs r
               WHERE r.account_key = a.account_key
                 AND r.provider = a.provider
                 AND r.started_at >= now() - interval '1 hour'
            ), 0) AS runs_last_hour,
            (
              SELECT min(r.started_at)
                FROM runs r
               WHERE r.account_key = a.account_key
                 AND r.provider = a.provider
                 AND r.started_at >= now() - interval '1 hour'
            ) AS hour_window_oldest
       FROM accounts a
      WHERE a.provider = $2 AND a.account_key = $1`,
    [accountKey, provider],
  );
  return rows[0] ?? null;
}

/**
 * How much of a measured burst allowance this account has already spent, counted from the run
 * rows themselves so the limit needs no extra column: every attempt counts, including a failed
 * one, because a request that reached the platform is what spends the allowance. Counting the
 * failures too is what makes the quiet period after a wall hold.
 */
async function countRunsInWindow(pool, accountKey, provider, windowMs) {
  const { rows } = await pool.query(
    `SELECT count(*)::integer AS runs_in_window, max(r.started_at) AS newest_run_at
       FROM runs r
      WHERE r.account_key = $1
        AND r.provider = $2
        AND r.started_at >= now() - ($3::double precision * interval '1 millisecond')`,
    [accountKey, provider, windowMs],
  );
  return {
    runsInWindow: Number(rows[0]?.runs_in_window) || 0,
    newestRunAt: rows[0]?.newest_run_at ?? null,
  };
}

export async function accountAvailability(pool, accountKey, config = safetyConfig(), provider = "doubao", pacing = null) {
  const state = await getAccountState(pool, accountKey, provider);
  const burst = pacing ? await countRunsInWindow(pool, accountKey, provider, pacing.pauseMs) : null;
  const verdict = classifyAccountState(state, { config, pacing, burst });
  return {
    available: verdict.kind === AVAILABILITY.AVAILABLE,
    kind: verdict.kind,
    reason: verdict.reason,
    retryAt: verdict.retryAt,
    paced: verdict.paced === true,
    state,
  };
}

export async function beginAccountRun(pool, accountKey, provider = "doubao") {
  const today = accountDayKey();
  await pool.query(
    `UPDATE accounts
        SET runs_today = CASE
              WHEN runs_today_date IS NULL OR runs_today_date <> $3::date THEN 1
              ELSE runs_today + 1
            END,
            runs_today_date = $3::date,
            last_run_at = now(),
            last_health_status = 'healthy',
            last_health_checked_at = now(),
            status = CASE WHEN status IN ('cooldown', 'rate_limited') THEN 'healthy' ELSE status END,
            cooldown_until = CASE WHEN status IN ('cooldown', 'rate_limited') THEN NULL ELSE cooldown_until END,
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider, today],
  );
}

export async function recordAccountSuccess(pool, accountKey, provider = "doubao") {
  await pool.query(
    `UPDATE accounts
        SET consecutive_failures = 0,
            status = 'healthy',
            last_health_status = 'healthy',
            last_health_checked_at = now(),
            pause_reason = NULL,
            paused_at = NULL,
            cooldown_until = NULL,
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider],
  );
}

export async function recordAccountFailure(
  pool,
  { accountKey, errorCode, provider = "doubao", config = safetyConfig() },
) {
  if (INFRASTRUCTURE_ERROR_CODES.has(errorCode)) {
    return {
      blocked: false,
      status: "infrastructure_error",
      failures: null,
      infrastructure: true,
    };
  }
  // A failure on a credential-free surface is a bug or a bad day on the site, never a spent
  // credential - cooling the lane down only stops the work it exists to do. The failed run is
  // still recorded; what changes is that the lane keeps taking the next question.
  if (isCredentialFreeSurface(provider)) {
    return { blocked: false, status: "degraded", failures: null, unmetered: true };
  }

  const blocking = ACCOUNT_BLOCKING_CODES[errorCode];

  if (blocking) {
    const cooldownMinutes =
      errorCode === "RATE_LIMITED"
        ? Number(config.rateLimitCooldownMinutes ?? config.cooldownMinutes)
        : config.cooldownMinutes;
    const cooldownUntil = blocking.manual
      ? null
      : new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
    const message =
      errorCode === "RATE_LIMITED"
        ? `${blocking.message} ${cooldownMinutes} 分钟`
        : blocking.message;
    await pool.query(
      `UPDATE accounts
          SET status = $3,
              paused_at = now(),
              pause_reason = $4,
              last_error_code = $5,
              last_health_status = $3,
              last_health_checked_at = now(),
              cooldown_until = $6,
              updated_at = now()
        WHERE provider = $2 AND account_key = $1`,
      [accountKey, provider, blocking.status, message, errorCode, cooldownUntil],
    );
    return { blocked: true, status: blocking.status, message, manual: blocking.manual };
  }

  const { rows } = await pool.query(
    `UPDATE accounts
        SET consecutive_failures = consecutive_failures + 1,
            last_error_code = $3,
            last_health_status = 'degraded',
            last_health_checked_at = now(),
            updated_at = now()
      WHERE provider = $2 AND account_key = $1
      RETURNING consecutive_failures`,
    [accountKey, provider, errorCode ?? null],
  );

  const failures = Number(rows[0]?.consecutive_failures ?? 0);
  if (failures >= config.maxConsecutiveFailures) {
    const cooldownUntil = new Date(Date.now() + config.cooldownMinutes * 60_000).toISOString();
    await pool.query(
      `UPDATE accounts
          SET status = 'cooldown',
              cooldown_until = $3,
              paused_at = now(),
              pause_reason = $4,
              updated_at = now()
        WHERE provider = $2 AND account_key = $1`,
      [
        accountKey,
        provider,
        cooldownUntil,
        `连续失败 ${failures} 次，冷却 ${config.cooldownMinutes} 分钟`,
      ],
    );
    return {
      blocked: true,
      status: "cooldown",
      message: `连续失败 ${failures} 次，已进入冷却`,
      manual: false,
    };
  }

  return { blocked: false, status: "degraded", failures };
}

export async function resumeAccount(pool, accountKey, provider = "doubao") {
  const { rowCount } = await pool.query(
    `UPDATE accounts
        SET status = 'healthy',
            paused_at = NULL,
            pause_reason = NULL,
            cooldown_until = NULL,
            consecutive_failures = 0,
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider],
  );
  return rowCount > 0;
}

export async function setAccountEnabled(pool, accountKey, enabled, provider = "doubao") {
  const { rowCount } = await pool.query(
    `UPDATE accounts
        SET enabled = $3,
            status = CASE WHEN $3 THEN 'unknown' ELSE 'disabled' END,
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider, enabled],
  );
  return rowCount > 0;
}

export async function markStorageStatePresent(pool, accountKey, present, provider = "doubao") {
  await pool.query(
    `UPDATE accounts SET storage_state_present = $3, updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider, present],
  );
}
