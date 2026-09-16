# OneGl Production Runtime Hardening

This note documents the production runtime guards around the Doubao collector and SaaS service API. These controls do not change the collection surface or bypass provider restrictions; they make multi-process deployment fail closed.

## 1. Cross-worker account execution lease

BullMQ `concurrency: 1` is local to one Worker instance. OneGl therefore also acquires PostgreSQL session advisory locks before any Doubao browser action:

1. one lock keyed by `account_key` — at most one worker process can execute that account;
2. one global slot keyed by `ONEGL_ACCOUNT_PARALLELISM` — the configured account parallelism is shared across every worker process using the same PostgreSQL database.

The advisory locks are held on a dedicated PostgreSQL session for the full browser execution and released in `finally`. If the process or database connection dies, PostgreSQL releases session locks automatically.

If a worker cannot acquire both locks, it does **not** open/use the browser or submit a prompt. The BullMQ job is moved to delayed state and retried after `ONEGL_ACCOUNT_LOCK_RETRY_MS` (default 15 seconds) without consuming the normal provider retry budget.

This layer sits in addition to existing account availability checks, hourly/daily limits, cooldowns and the rule that a possibly-submitted prompt is not automatically retried.

## 2. Webhook SSRF boundary

Webhook delivery treats endpoint URLs as untrusted outbound destinations.

Before every delivery attempt OneGl:

- permits HTTPS by default (`ONEGL_WEBHOOK_ALLOW_HTTP=true` is development-only);
- rejects URL credentials;
- resolves the hostname immediately before connection;
- rejects the complete DNS result if **any** answer is loopback, private, carrier-grade NAT, link-local, documentation/reserved, multicast or otherwise blocked by the explicit CIDR policy;
- pins the actual socket DNS lookup to a prevalidated public address so the hostname cannot resolve to a different private address between validation and connect;
- does not follow redirects;
- bounds the response body retained in delivery diagnostics.

Both IPv4 and IPv6 are checked. IPv4-mapped IPv6 is blocked as an IPv6 special range.

`ONEGL_WEBHOOK_ALLOW_HTTP` only relaxes the scheme requirement. It never permits private/internal IP destinations.

## 3. Remote login runtime ownership

The real provider browser cannot be serialized into PostgreSQL, so one API process remains the runtime owner of a login browser. What is made durable is the coordination state:

- `runtime_owner`
- `runtime_heartbeat_at`
- latest screenshot and screenshot timestamp
- cancellation request
- existing auth-session status/details/expiry/completion state

Consequences for a horizontally routed API deployment:

- `GET /v1/auth-sessions/{id}` can report browser activity using the durable owner heartbeat even when the request lands on another API node;
- `GET /v1/auth-sessions/{id}/screenshot` can serve the latest persisted screenshot from PostgreSQL instead of requiring sticky routing;
- cancellation is written to PostgreSQL and does not depend on reaching the browser-owning node;
- the owner checks durable state on every poll and closes its browser when ownership/session validity is lost;
- an owner heartbeat older than `ONEGL_REMOTE_AUTH_OWNER_TIMEOUT_MS` (default 30 seconds) is reported as inactive.

A graceful API-owner shutdown marks its still-active auth sessions failed with a runtime-owner-shutdown reason. It does not pretend the user cancelled them.

## 4. Safety boundary remains unchanged

Runtime hardening is not an evasion layer. OneGl still does not expose arbitrary browser-control endpoints, solve CAPTCHA/verification challenges, spoof fingerprints, rotate proxies to evade limits, or continue execution through access restrictions. Verification and access restrictions remain fail-closed/manual states.

## 5. Production configuration

Recommended baseline:

```env
ONEGL_ACCOUNT_PARALLELISM=1
ONEGL_ACCOUNT_LOCK_RETRY_MS=15000
ONEGL_REMOTE_AUTH_OWNER_TIMEOUT_MS=30000
ONEGL_WEBHOOK_TIMEOUT_MS=10000
ONEGL_WEBHOOK_MAX_ATTEMPTS=5
```

Keep the Service API behind TLS/private networking and use HTTPS webhook destinations. All collector worker processes that are intended to share concurrency limits must use the same PostgreSQL database.

## 6. Remaining secret-at-rest work

This hardening does not by itself encrypt browser `storageState` or deployment secrets at rest. Production deployments should still protect the OneGl data directory, database backups and environment/secret-manager material. A dedicated storageState/secret encryption layer is a separate hardening step.
