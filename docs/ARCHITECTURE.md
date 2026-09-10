# OneGl Doubao MVP architecture

## Goal

Phase 1 proves one reliable data chain before adding scoring or multiple providers:

`Prompt -> Doubao Web UI -> Answer -> Visible Citation -> Article`

The browser UI is the source of truth for `visible_to_user`. We deliberately do not
claim access to model training data, hidden model reads, or sources merely because a
network request happened.

## Runtime

- **Browser automation:** Playwright Core.
- **Default browser:** Camoufox, resolved through the same Python `camoufox.utils.launch_options`
  approach used by upstream OneGlanse.
- **Authentication:** first login is manual; Playwright `storageState` is persisted locally
  under `.onegl/auth/` and reused by later runs.
- **Isolation:** every prompt calls the Doubao “新对话” control when available; if the current
  URL is a concrete conversation and the control is unavailable, the runner navigates back to
  `/chat/` before submission.
- **Completion:** answer text must be non-empty, generation controls must be inactive, and the
  answer must remain stable for multiple polls.

## Citation truth model

The MVP stores only DOM-confirmed visible sources:

- `sourceType = visible`
- `capturedFrom = DOM`
- `visibleToUser = true`

When Doubao renders a block identified by `block_type:10025`, the collector reads the UI signal
`搜索 N 个关键词，参考 M 篇资料`. `M` becomes an explicit expected citation count.

If fewer visible links are present, the collector tries to open the reference UI and reads a
single visible reference overlay. If the final unique URL count still differs from `M`, the run
is **partial** with `CITATION_PARSE_FAILED`; it is not silently treated as a successful run with
missing citations.

No network result is promoted to a citation in Phase 1.

## Run persistence

Phase 1 intentionally uses local filesystem persistence so browser behavior can be validated
before committing to a database migration. Each run gets an immutable evidence directory:

```text
.onegl/runs/run_.../
  run.json
  answer.md                 # when answer capture succeeds
  citations.json            # when answer capture succeeds
  screenshot.png
  page.html
  partial-answer.md         # timeout with partial text only
```

`run.json` includes prompt, timestamps, answer, source rows, expected citation count, status,
error code/message/details, current URL, and debug path.

## Error semantics

Session-blocking errors stop a batch instead of continuing to hammer Doubao:

- `DOUBAO_LOGIN_REQUIRED`
- `DOUBAO_SESSION_EXPIRED`
- `DOUBAO_VERIFICATION_REQUIRED`
- `DOUBAO_ACCESS_RESTRICTED`

Other persistent run errors include `DOUBAO_TIMEOUT`, `DOUBAO_SUBMISSION_FAILED`,
`ANSWER_NOT_FOUND`, `CITATION_PARSE_FAILED`, `PAGE_CHANGED`, `RATE_LIMITED`,
`NETWORK_ERROR`, and `UNKNOWN_ERROR`.

## Next integration step

After real-account validation passes, this core should be merged into the full OneGlanse
provider registry and queue worker. The next data change is PostgreSQL-backed `prompts`, `runs`,
and `run_citations`; ClickHouse can remain an analytics sink rather than the durable lifecycle
store. A Doubao SSE/network collector can then be added as provenance-aware **retrieved-source**
evidence, never as an automatic replacement for DOM-visible citations.
