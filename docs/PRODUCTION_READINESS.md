# Production readiness and startup safety

OneGl separates **liveness** from **readiness** so a process can stay observable without accepting new work when a required dependency or safety control is unavailable.

## HTTP probes

The Service API exposes two unauthenticated operational endpoints on the normal API port:

- `GET /healthz` — process/liveness view. It returns HTTP 200 even when dependencies are degraded so a supervisor does not restart a healthy process just because PostgreSQL is temporarily unavailable.
- `GET /readyz` — traffic/readiness view. It returns HTTP 200 only when OneGl can safely accept work and HTTP 503 otherwise.

`/readyz` checks:

- PostgreSQL connectivity;
- whether every migration present in the deployed repository is recorded in `schema_migrations`;
- Redis connectivity for API/worker/monitor roles;
- production storageState encryption requirements;
- production webhook-signing requirements;
- that development-only HTTP webhook delivery is disabled in production.

Load balancers and orchestrators should use `/readyz` for readiness/traffic gating and `/healthz` for liveness.

## Production mode

Enable strict startup safety with either:

```env
ONEGL_PRODUCTION=true
```

or the conventional:

```env
NODE_ENV=production
```

In production mode, the supported process entrypoints fail before importing the long-running service when required static security configuration is incomplete:

```bash
npm run api:serve
npm run worker
npm run webhook:worker
npm run monitor:worker
```

The API and collection worker require an explicitly enforced storageState encryption configuration. The API and webhook worker require a sufficiently long webhook signing key. API/worker/monitor roles require Redis configuration. All production roles require PostgreSQL configuration. `ONEGL_WEBHOOK_ALLOW_HTTP=true` is rejected in production.

A missing `ONEGL_API_KEY` is reported as an advisory rather than a hard production failure because normal tenant client keys are stored hashed in PostgreSQL and remain usable. The master key is only needed for bootstrap/admin master operations.

## Deployment check CLI

Run the same readiness logic from deployment automation:

```bash
npm run runtime:check -- --role api
npm run runtime:check -- --role worker
npm run runtime:check -- --role webhook
npm run runtime:check -- --role monitor
```

The command emits JSON and exits non-zero when the role is not ready. Use `--static` when a build/release stage should validate only configuration without contacting PostgreSQL or Redis:

```bash
npm run runtime:check -- --role api --static
```

A recommended rollout sequence is:

1. inject secrets and runtime configuration;
2. apply migrations with `npm run db:migrate`;
3. run `npm run runtime:check -- --role api` and the checks for enabled worker roles;
4. start the processes;
5. wait until `/readyz` returns HTTP 200;
6. only then add the instance to the traffic pool.

## Readiness is deliberately fail-closed

OneGl does not report ready merely because the Node.js process is listening. A database connection without the deployed migrations, a configured Redis URL that cannot be pinged, or missing production encryption/signing controls all keep readiness at 503.

This does not bypass or relax any provider-side restrictions. Account login expiration, verification requirements, access restrictions, cooldowns and rate limits continue to be handled by the existing account safety layer and can still make an individual account or execution unavailable even while the service itself is ready.

## StorageState key rotation

Use `npm run storage:rotate` for maintenance-mode AES-GCM re-encryption. See `docs/STORAGE_STATE_SECURITY.md` for the complete procedure. Stop all account-executing workers and remote-auth writers before rotation, validate with `--dry-run`, rotate, remove the old key, then re-run readiness before restoring traffic.
