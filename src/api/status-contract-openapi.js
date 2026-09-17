const enums = {
  AccountResource: [
    "healthy",
    "login_required",
    "session_expired",
    "verification_required",
    "access_restricted",
    "paused",
    "cooldown",
    "rate_limited",
    "disabled",
  ],
  AuthSessionResource: [
    "starting",
    "waiting_for_login",
    "connected",
    "verification_required",
    "access_restricted",
    "failed",
    "cancelled",
    "expired",
  ],
  BatchSummaryResource: ["pending", "queued", "running", "paused", "completed", "partial", "failed", "aborted"],
  RunResource: ["success", "partial", "failed"],
  WebhookEventResource: ["pending", "delivering", "delivered", "failed"],
};

export function applyStatusContractOpenApi(document) {
  const schemas = document.components?.schemas;
  if (!schemas) throw new Error("OpenAPI components.schemas must exist before status contract hardening");

  for (const [schemaName, values] of Object.entries(enums)) {
    const status = schemas[schemaName]?.properties?.status;
    if (status) status.enum = values;
  }
  return document;
}
