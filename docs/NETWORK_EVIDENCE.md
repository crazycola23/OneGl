# Doubao Network / SSE evidence

This module is an **experimental provenance layer** for studying how Doubao Web moves from a prompt to search queries and retrieved candidate sources.

It is deliberately separate from OneGl's DOM-visible citation truth model.

## Enable

```bash
ONEGL_NETWORK_EVIDENCE=true npm run run -- --prompt "..."
```

Optional limits:

```bash
ONEGL_NETWORK_MAX_BODY_BYTES=4194304
ONEGL_NETWORK_BODY_TIMEOUT_MS=8000
```

The feature is opt-in until the current Doubao response shape has been validated against an authorised real account.

## What is captured

For internal Doubao/ByteDance responses that look like search-result traffic, OneGl parses JSON/SSE payloads and looks for search-result blocks such as `block_type:10025` and related `search_query_result` structures.

The collector can extract:

- generated search queries;
- external retrieved source URL;
- title when present;
- source/site name when present;
- summary/snippet when present;
- source position/rank when present;
- sanitized response endpoint, status, content type and body size.

A run writes:

```text
.onegl/runs/<run_id>/attempts/<n>/network-evidence.json
```

`run.json` additionally records:

```json
{
  "networkEvidenceState": "found",
  "searchQueries": [],
  "retrievedSources": [],
  "networkEvidenceDiagnostics": []
}
```

## What is not captured

Raw network response bodies are **not persisted**. Endpoint query strings are removed before evidence is saved, so conversation IDs or similar query parameters are not copied into the artifact.

The collector does not read browser cookies or authentication headers into the evidence output.

## Source semantics

A network source is always emitted as:

```json
{
  "sourceType": "retrieved",
  "capturedFrom": "NETWORK",
  "visibleToUser": false,
  "relationStatus": "unresolved"
}
```

This means only:

> the source was observed in a search/retrieval-shaped network payload.

It does **not** mean:

- the user saw the source in the final answer;
- the model used the source when writing a sentence;
- the source was ranked above another candidate internally;
- the source belongs to model training data.

Only the DOM citation extractor may establish `sourceType = visible`.

## Research use

The intended analysis chain is:

```text
Prompt
  -> generated search queries
  -> retrieved candidate sources
  -> DOM-visible citations
  -> final answer
```

With repeated controlled prompts, this makes it possible to measure candidate-to-citation conversion rates without pretending that the server-side ranking formula is directly observable.

## Validation checklist

Before enabling this for a large batch, run a small authorised test set and verify:

1. `network-evidence.json` contains the same search-query wording shown by the product when such wording is visible.
2. Retrieved URLs are genuine source candidates rather than unrelated telemetry/navigation URLs.
3. No session token, cookie, authorization header or raw response body appears in the artifact.
4. `citations.json` is unchanged by the network collector.
5. Runs with network evidence disabled behave identically to the previous collector path.

If Doubao changes its response shape, prefer recording `state = none/partial` over guessing new field meanings.
