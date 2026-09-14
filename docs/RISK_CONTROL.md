# OneGl operation and risk-control model

OneGl automates a logged-in browser session. That creates operational and account risk even when
the research itself is authorised. This document treats those risks as something to reduce, not
something to evade.

## Current risk assessment

The main risk factors in the earlier implementation were:

1. **Cadence was aggressive.** The default gap between jobs was only 4–9 seconds. That is a high
   automation cadence for an account-bound consumer UI.
2. **No rolling hourly ceiling.** A daily cap alone can still allow a burst of many runs in a short
   window.
3. **Rate-limit backoff was too short.** Explicit rate-limit signals used the same 30-minute
   cooldown as ordinary repeated failures.
4. **Retries were not idempotent.** `DOUBAO_TIMEOUT`, `NETWORK_ERROR` and `UNKNOWN_ERROR` were all
   treated as safe to retry. Any of them can happen *after* the prompt reached the platform, so a
   retry could send the same prompt twice: a duplicated sample and exactly the pattern that looks
   like abuse.
5. **Browser identity drifted between cold starts.** Every launch created a fresh context with no
   locale, timezone or viewport, so a Worker restart presented a different device fingerprint than
   the session it was resuming.
6. **A crashed browser was indistinguishable from platform friction.** A dead session produced a
   stream of timeouts that looked like the platform refusing the account.
4. **Front-end fallback could change modes.** If `新对话` was unavailable, the collector also tried
   `新工作任务`, which can change the product interaction mode instead of simply starting a clean
   chat.
5. **A previous turn could still be active.** The old collector relied primarily on the downstream
   answer path; there was no separate preflight that refused to start while the UI was already
   generating.
6. **Browser behavior humanization was configured.** That is not appropriate for a compliance- and
   stability-oriented design. OneGl should reduce load and stop on platform signals rather than
   try to make automation look human.

## Mitigations added

### Front-end preflight guard

Before each prompt, `src/front-end-guard.js` now:

- checks for verification and access-restriction states;
- waits for an existing active turn to become idle, then stops rather than submitting if it stays
  busy;
- returns to the normal `/chat/` entry if a conversation-specific page has lost its normal
  `新对话` control;
- records a preflight snapshot on the local Run record;
- blocks the legacy automatic `新工作任务` fallback.

The guard does not solve verification, dismiss restrictions, alter challenge state, spoof input,
or automatically resubmit an uncertain prompt.

### Conservative account pacing

OneGl now defaults to:

- 30–90 seconds random delay between queued jobs;
- at least 45 seconds between run starts;
- at most 10 runs in a rolling hour per account;
- 40 runs per account per account-local day;
- 60-minute cooldown after repeated ordinary failures;
- 180-minute cooldown after an explicit rate-limit signal;
- global account parallelism of 1.

Volume is not the variable that should be raised to collect more data. If a batch needs more
samples than these ceilings allow, spread it across more accounts or more days, and sample the same
keyword at different times of day rather than back-to-back.

These are **OneGl safety defaults**, not official Doubao limits and not a claim about unpublished
platform detection thresholds. Users remain responsible for applicable terms, permissions and any
published limits.

### Dashboard risk controls

The operator console now uses the same shared risk model as `npm run risk:audit`.

On the homepage and Accounts page it shows:

- overall local operational risk (`low` / `medium` / `high`);
- per-account risk and explicit reasons;
- today’s account usage versus the daily ceiling;
- recent one-hour usage versus the rolling hourly ceiling, calculated from OneGl’s existing Runs
  data without making another provider request;
- the next time an account is expected to be eligible to run again when the reason is a cooldown,
  minimum inter-run gap, daily ceiling, or rolling hourly ceiling;
- current active batch count.

The left sidebar also exposes a compact risk lamp on every page.

The **一键暂停当前全部采集** button reuses the existing batch stop operation for every currently
queued/running batch. Waiting jobs are cancelled; a browser task that is already executing is
allowed to finish safely. The control does not clear or overwrite account states such as
`rate_limited`, `verification_required`, or `access_restricted`, and it does not solve or bypass
platform controls.

### Idempotent retries

`executeDoubaoPrompt` now tags every failure with where the pipeline stopped:

- `stage: "pre-submit"` and `promptSubmitted: false` — the prompt was never sent, so a retry cannot
  duplicate anything;
- `stage: "submit"` and `promptSubmitted: true` — the platform may already have the prompt.

`canRetryOutcome()` only allows a retry for `DOUBAO_TIMEOUT` / `NETWORK_ERROR` when
`promptSubmitted === false` is present. A missing flag is read as "may have been submitted", so the
job stops instead of re-sending. `UNKNOWN_ERROR` is no longer retryable at all: an unidentified
failure could be a duplicate send, and losing one sample is cheaper than corrupting the batch.

### Stable browser identity

Each account's browser context is created with an explicit `locale`, `timezone` and `viewport`
(`ONEGL_BROWSER_LOCALE`, `ONEGL_BROWSER_TIMEZONE`, `ONEGL_BROWSER_VIEWPORT_WIDTH/HEIGHT`). This is
deliberately *not* fingerprint spoofing: the values should be the operator's real locale and
timezone. The point is that the same account looks like the same returning user across Worker
restarts instead of a new device on every launch.

### Session health

A per-account browser session is health-checked before reuse (`browser.isConnected()`, open pages,
`page.isClosed()`). A dead session is closed and rebuilt instead of being reused for every
subsequent job. Rebuilding is cheap; a stream of failures against a dead browser is not, because it
is easily mistaken for platform rejection.

### Front-end preflight

Before each prompt the guard now:

- requires the session state to be positively `healthy` — an `unknown` state fails closed rather
  than submitting into a page whose state cannot be described;
- requires several consecutive idle readings (`ONEGL_FRONTEND_STABLE_IDLE_POLLS`, default 3) instead
  of a single one, because the progress row can blink between stream chunks;
- waits up to `ONEGL_FRONTEND_IDLE_WAIT_MS` (default 60s) for that stable idle state;
- does **not** fall back to `新工作任务`. That control switches the product into a different
  interaction mode, so the fallback was removed from `startCleanConversation()` itself rather than
  only being intercepted by the guard.

### Verification / restriction handling

These states remain fail-closed and require manual handling:

- login required;
- saved session expired;
- human verification required;
- access restricted.

No captcha solving or access-control bypass is implemented.

### Browser behavior

Camoufox remains supported for compatibility with the existing project, but OneGl no longer asks
it to humanize browser behavior. For routine authorised monitoring, a normal visible
Chromium/Firefox installation is operationally simpler when it works reliably with the current UI.

## Local risk audit

Run:

```bash
npm run risk:audit
```

or:

```bash
npm run risk:audit -- --json
```

The audit checks local configuration for elevated operational risk such as:

- very short delays;
- high parallelism;
- large hourly/daily ceilings;
- short rate-limit cooldowns;
- headless operation;
- non-standard browser backend use.

It is a local heuristic. It does **not** reveal or infer Doubao's hidden anti-abuse rules, and a
low result is not an assurance that automation is permitted.

## Recommended operating procedure

For a new account/session or after a UI change:

1. run `npm run risk:audit` and check the Dashboard risk panel;
2. keep the browser visible;
3. run a very small fixed validation set first;
4. stop immediately if verification, access restriction or repeated rate-limit signals appear;
5. inspect saved screenshots / DOM / run metadata before increasing batch size;
6. increase volume only as needed for the research question, not to maximise throughput.

## Residual risks

Even with these controls, residual risk remains because:

- the site can change DOM and session behavior at any time;
- product terms or published automation limits can change;
- account reputation and server-side signals are not observable from OneGl;
- repeated fresh-conversation creation is itself a regular, visible product action;
- network provenance capture observes implementation details that may change without notice.

OneGl therefore treats explicit platform friction as a stop/backoff signal, not a challenge to work
around.
