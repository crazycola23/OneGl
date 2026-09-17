import { applyObservabilityOpenApi as applyBaseObservabilityOpenApi } from "./observability-openapi-base.js";

const appliedDocuments = new WeakSet();

export function applyObservabilityOpenApi(document) {
  if (appliedDocuments.has(document)) return document;
  applyBaseObservabilityOpenApi(document);
  appliedDocuments.add(document);
  return document;
}
