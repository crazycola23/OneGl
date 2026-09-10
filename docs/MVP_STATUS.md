# MVP status

## Implemented in this slice

- Doubao Web entry at `https://www.doubao.com/chat/`.
- Camoufox-first Playwright browser launcher.
- Manual first login and local `storageState` reuse.
- Session states: healthy, login required/expired, verification required, access restricted,
  and unknown/page-changed.
- Clean-conversation attempt before every prompt.
- Prompt input verification and fail-closed submission confirmation (no blind auto-resubmit).
- Answer capture centered on `.md-box-root` with streaming/stability completion checks.
- DOM-visible source extraction from the Doubao `block_type:10025` reference block.
- Parsing and enforcement of the UI-declared `参考 M 篇资料` count.
- Reference overlay fallback for sources hidden behind a UI expander.
- Conservative URL canonicalization that removes tracking parameters but preserves generic
  `source`/`ref` parameters.
- Per-run screenshots, HTML snapshots, answer/citation files, and machine-readable errors.
- Sequential batch runner with jitter and session-health stop conditions.
- Read-only local Runs / Run Detail / Sources dashboard for human verification.

## Deliberately not implemented yet

- Network/SSE source capture as a production data source.
- Retrieved Source / Cited Source inference beyond UI evidence.
- PostgreSQL / ClickHouse persistence.
- BullMQ / Redis scheduling.
- Multi-provider support.
- GEO, sentiment, recommendation, competitor, or brand scoring.
- Prompt generation, payment, SaaS permissions, reports, or training-data claims.

## Validation gate before the next slice

Use a logged-in Doubao account and a fixed 20-30 prompt suite. For each run compare the saved
screenshot against `run.json` and record:

1. answer present in UI vs answer captured;
2. visible reference count in UI vs `expectedCitationCount`;
3. source title/URL/order vs the expanded reference UI;
4. new-conversation isolation between consecutive prompts;
5. session-expiry and verification behavior.

The MVP should not advance to analytics work until answer capture is consistently >95% when a
visible answer exists and visible citation capture matches the UI evidence accurately.
