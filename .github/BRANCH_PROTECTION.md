# Repository governance for `main`

OneGl relies on CI for migration, PostgreSQL integration, API contract, runtime-hardening, syntax and unit-test checks. Those checks only protect production if `main` cannot bypass them through a direct push.

## Required GitHub ruleset

Create a repository ruleset targeting the default branch (`main`) with these controls:

- require changes through pull requests;
- require at least one approving review before merge;
- dismiss stale approvals when new commits are pushed;
- require conversation resolution before merge;
- require the `test` status check from the `CI` workflow;
- require the branch to be up to date before merging;
- block force pushes;
- block branch deletion;
- do not allow bypass for routine maintainer pushes.

The live Doubao canary is intentionally **not** a required PR check. It uses a real authenticated provider session and is kept separate from deterministic CI.

## Live-canary secrets

Use a dedicated low-volume canary account, not a personal Doubao account. Configure:

- secret `ONEGL_CANARY_STORAGE_STATE_KEY`: the same AES-256-GCM key used when the canary account storage state was created;
- secret `ONEGL_CANARY_STORAGE_STATE_ENVELOPE`: the full contents of `.onegl/auth/accounts/canary.storage.json.enc` created locally with `npm run auth -- --account canary`;
- repository variable `ONEGL_LIVE_CANARY_ENABLED=true` only after the secrets are configured and a manual run succeeds;
- optional variable `ONEGL_CANARY_PROMPT` to override the neutral compatibility prompt.

The workflow does not upload authenticated HTML/screenshots as artifacts. A failure should be investigated from the structured job log or by reproducing locally with the dedicated canary account.

## Interpreting the canary

A passing canary proves only current browser/session/DOM compatibility for one low-volume observation. It does not prove that Doubao behavior, citation policy, ranking or network payloads are stable. Network evidence remains experimental unless separately validated.
