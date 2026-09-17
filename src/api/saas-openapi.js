import { applySaasOpenApi as applyBaseSaasOpenApi } from "./saas-openapi-base.js";

const appliedDocuments = new WeakSet();

export function applySaasOpenApi(document) {
  if (appliedDocuments.has(document)) return document;
  applyBaseSaasOpenApi(document);
  appliedDocuments.add(document);
  return document;
}
