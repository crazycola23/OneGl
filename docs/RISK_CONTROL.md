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

- 15–30 seconds random delay between queued jobs;
- at least 15 seconds between run starts;
- at most 20 runs in a rolling hour per account;
- 60 runs per account per account-local day;
- 60-minute cooldown after repeated ordinary failures;
- 120-minute cooldown after an explicit rate-limit signal;
- global account parallelism of 1.

These are **OneGl safety defaults**, not official Doubao limits and not a claim about unpublished
platform detection thresholds. Users remain responsible for applicable terms, permissions and any
published limits.

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

1. run `npm run risk:audit`;
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
