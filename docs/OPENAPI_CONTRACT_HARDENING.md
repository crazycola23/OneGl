# OpenAPI Contract Hardening

OneGl exposes an OpenAPI 3.1 contract for server-to-server integrations. The public contract version in this branch is `0.7.0`.

## Source of truth

`src/api/build-openapi.js` is the only contract assembly entry point. It deep-clones the base document and applies contract layers in a deterministic order. The same builder feeds:

- the runtime `GET /openapi.json` document;
- the committed `openapi.json` artifact;
- `generated/openapi.d.ts`;
- contract tests and CI compatibility checks.

Do not mutate `openApiDocument` from route modules or after the API server has started.

## Build and validation

```bash
npm run openapi:build
npm run openapi:lint
npm run openapi:types
npm run openapi:typecheck
npm run openapi:check
```

`openapi:check` rebuilds the static contract, runs Redocly, regenerates TypeScript definitions, type-checks the generated declaration, runs contract coverage tests, and fails if committed generated files drift.

Pull requests also run an `oasdiff` breaking-change gate. This PR establishes the first committed `openapi.json` baseline; after it is merged, future pull requests compare their contract against the target branch.

## Compatibility policy

`/v1` is additive. Existing documented fields, meanings, enum members, paths, response semantics and `operationId` values are compatibility-sensitive. A breaking public contract requires explicit compatibility review and, when necessary, a new major API path.

Safe additive examples include new optional response fields, new optional request fields, and new paths. Removing a path or field, making an optional field required, narrowing an enum, changing an `operationId`, or changing an existing error meaning is treated as breaking.

## Generated TypeScript types

```ts
import type { components } from "../generated/openapi.js";

type ProjectCreate = components["schemas"]["ProjectCreate"];
type TaskCreate = components["schemas"]["TaskCreate"];
type Execution = components["schemas"]["ExecutionResource"];
type Report = components["schemas"]["ReportResource"];
```

The generated declaration is a type artifact, not an HTTP client. A product backend can use these types with `fetch`, Axios, or a generated client library.

## Minimal typed client helper

```ts
const baseUrl = process.env.ONEGL_URL ?? "https://onegl.internal";
const apiKey = process.env.ONEGL_API_KEY!;

async function onegl<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${payload.error ?? "onegl_error"}: ${payload.message ?? response.statusText}`);
  }
  return payload;
}
```

## Create a Project

```ts
import type { components } from "../generated/openapi.js";

type ProjectCreate = components["schemas"]["ProjectCreate"];
type Project = components["schemas"]["ProjectResource"];

const input: ProjectCreate = {
  name: "小米汽车",
  external_id: "project_9081",
  target_brand: "小米汽车",
  keywords: ["20万新能源SUV推荐", "国产新能源车哪个品牌值得买"],
};

const { data: project } = await onegl<{ data: Project }>("/v1/projects", {
  method: "POST",
  body: JSON.stringify(input),
});
```

## Create a Task

```ts
import type { components } from "../generated/openapi.js";

type TaskCreate = components["schemas"]["TaskCreate"];
type Task = components["schemas"]["TaskResource"];

const input: TaskCreate = {
  external_id: "saas_project_1024",
  name: "小米汽车 GEO 监测",
  target_brand: "小米汽车",
  questions: ["20万左右新能源SUV推荐", "国产新能源车哪个品牌值得买"],
  platforms: ["doubao"],
  account_ids: ["doubao-main"],
  sampling: { method: "stratified", repeats: 1 },
};

const { data: task } = await onegl<{ data: Task }>("/v1/tasks", {
  method: "POST",
  headers: { "Idempotency-Key": "task-create-1024" },
  body: JSON.stringify(input),
});
```

## Create an Execution

```ts
import type { components } from "../generated/openapi.js";

type Execution = components["schemas"]["ExecutionResource"];

const { data: execution } = await onegl<{ data: Execution }>(
  `/v1/tasks/${task.task_id}/executions`,
  {
    method: "POST",
    headers: { "Idempotency-Key": "execution-2026-09-17-001" },
    body: JSON.stringify({}),
  },
);
```

## Poll an Execution

```ts
import type { components } from "../generated/openapi.js";

type Execution = components["schemas"]["ExecutionResource"];

const terminal = new Set(["completed", "partial", "failed", "cancelled"]);
let current: Execution;

do {
  ({ data: current } = await onegl<{ data: Execution }>(
    `/v1/executions/${execution.execution_id}`,
  ));
  if (!terminal.has(current.status)) await new Promise((resolve) => setTimeout(resolve, 2000));
} while (!terminal.has(current.status));
```

## Get a Report

```ts
import type { components } from "../generated/openapi.js";

type Report = components["schemas"]["ReportResource"];

const { data: report } = await onegl<{ data: Report }>(
  `/v1/executions/${execution.execution_id}/report`,
);
```

The report has a stable `report_id`; callers may also query it later with `GET /v1/reports/{reportId}`.

## Verify a Webhook signature

The runtime webhook worker sends these headers:

```text
X-OneGl-Event
X-OneGl-Event-Id
X-OneGl-Webhook-Version: 1
X-OneGl-Timestamp
X-OneGl-Signature: v1=<hex HMAC-SHA256>
```

The signed input is exactly `<timestamp>.<raw request body>`. Verification must use the raw body bytes before JSON re-serialization.

```ts
import crypto from "node:crypto";

export function verifyOneGlWebhook({
  rawBody,
  timestamp,
  signature,
  secret,
  maxAgeSeconds = 300,
}: {
  rawBody: Buffer;
  timestamp: string;
  signature: string;
  secret: string;
  maxAgeSeconds?: number;
}) {
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > maxAgeSeconds) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
  const expected = Buffer.from(`v1=${digest}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
```

After signature verification, deduplicate side effects by `X-OneGl-Event-Id`.

## Documentation responsibilities

- `docs/OPENAPI_SERVICE_PLAN.md`: service architecture, deployment, tenant/client bootstrap and security boundaries.
- `docs/SAAS_TASK_API.md`: Task → Execution → Result → Report business flow.
- `docs/SAAS_PRODUCTION_CONTRACT.md`: idempotency, pagination, retry and webhook compatibility behavior.
- `docs/OPENAPI_CONTRACT_HARDENING.md`: contract build/tooling workflow and generated-type examples.
- `openapi.json`: machine-readable field and operation contract used by generators and compatibility tooling.

If prose and generated code disagree on a request/response field, fix the builder/runtime mismatch and regenerate `openapi.json`; do not hand-edit the generated contract.
