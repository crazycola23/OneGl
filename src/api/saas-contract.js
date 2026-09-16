export const EXECUTION_STATUSES = Object.freeze([
  "pending",
  "queued",
  "running",
  "paused",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

export const RESULT_STATUSES = Object.freeze([
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
]);

export const REPORT_STATUSES = Object.freeze(["generating", "ready"]);

export function publicExecutionStatus(status) {
  if (status === "aborted") return "cancelled";
  return EXECUTION_STATUSES.includes(status) ? status : "pending";
}

export function publicResultStatus(status) {
  if (status === "success") return "completed";
  return RESULT_STATUSES.includes(status) ? status : "pending";
}

export function publicReportStatus(executionStatus) {
  return ["completed", "partial", "failed", "cancelled"].includes(publicExecutionStatus(executionStatus))
    ? "ready"
    : "generating";
}
