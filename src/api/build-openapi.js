import { applyContractHardeningOpenApi } from "./contract-hardening-openapi.js";
import { applyCustomerDashboardOpenApi } from "./customer-dashboard-openapi.js";
import { applyObservabilityOpenApi } from "./observability-openapi.js";
import { openApiDocument as baseOpenApiDocument } from "./base-openapi.js";
import { applySaasOpenApi } from "./saas-openapi.js";
import { applySaasPatchOpenApi } from "./saas-patch-openapi.js";

export function buildOpenApiDocument() {
  const document = structuredClone(baseOpenApiDocument);
  applySaasOpenApi(document);
  applyCustomerDashboardOpenApi(document);
  applySaasPatchOpenApi(document);
  applyContractHardeningOpenApi(document);
  applyObservabilityOpenApi(document);
  return document;
}

export const openApiDocument = buildOpenApiDocument();
