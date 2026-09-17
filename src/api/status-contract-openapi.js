const enums = {
  AccountResource: [
    "unknown",
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
    "pending",
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
  RunResource: ["pending", "running", "success", "partial", "failed"],
  WebhookEventResource: ["queued", "delivering", "delivered", "failed"],
  MonitorExecutionResource: ["pending", "processing", "completed", "skipped", "failed"],
  ScheduleExecutionItem: ["pending", "processing", "completed", "failed", "action_required"],
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
