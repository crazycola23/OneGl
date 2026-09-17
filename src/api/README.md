# OneGl Service API

The public service implementation lives in `src/api-server.js` with tenant/client/webhook state helpers in `service-store.js`, constrained remote login in `remote-auth.js`, durable webhook delivery in `src/webhook-worker.js`, and the OpenAPI 3.1 contract assembled by `buildOpenApiDocument()` in `build-openapi.js`.

`openapi.js` exports the deterministic final document used by the runtime `/openapi.json` endpoint. The same builder generates the committed `openapi.json` and `generated/openapi.d.ts`, so runtime docs, static docs, and generated client types share one source of truth.

OpenAPI development commands:

```bash
npm run openapi:build   # regenerate openapi.json
npm run openapi:lint    # Redocly validation/lint
npm run openapi:types   # regenerate generated/openapi.d.ts
npm run openapi:check   # build + lint + types + contract tests + generated-file drift check
```

Pull requests also run an OpenAPI breaking-change gate. The initial committed `openapi.json` establishes the baseline because older `main` revisions do not contain a static contract; once merged, later changes are compared against the base branch and breaking changes fail CI.

See `docs/OPENAPI_SERVICE_PLAN.md` for deployment, tenant/client bootstrap, account-connect, task/execution/report and webhook integration flows.
