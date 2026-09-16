# OneGl OpenAPI Service Plan

This branch introduces the first service-facing API layer for OneGl. The goal is to let another trusted platform use OneGl as an execution service without exposing browser-control primitives.

Initial scope:

- server-to-server API key authentication;
- business-level batch endpoints (create/start/stop/status/runs/report);
- OpenAPI description suitable for Swagger/SDK generation;
- no remote CAPTCHA solving or access-control bypass;
- no browser cookies/storageState returned to callers;
- OneGl dashboard remains an internal/admin surface.
