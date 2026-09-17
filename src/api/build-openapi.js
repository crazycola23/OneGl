import { applyContractHardeningOpenApi } from "./contract-hardening-openapi.js";
import { applyCustomerDashboardOpenApi } from "./customer-dashboard-openapi.js";
import { applyErrorContractOpenApi } from "./error-contract-openapi.js";
import { applyMonitoringContractOpenApi } from "./monitoring-contract-openapi.js";
import { applyObservabilityOpenApi } from "./observability-openapi.js";
import { openApiDocument as baseOpenApiDocument } from "./base-openapi.js";
import { applyResourceContractOpenApi } from "./resource-contract-openapi.js";
import { applySaasOpenApi } from "./saas-openapi.js";
import { applySaasPatchOpenApi } from "./saas-patch-openapi.js";
import { applyStatusContractOpenApi } from "./status-contract-openapi.js";
import { applyWebhookContractOpenApi } from "./webhook-contract-openapi.js";

export function buildOpenApiDocument() {
  const document = structuredClone(baseOpenApiDocument);
  applySaasOpenApi(document);
  applyCustomerDashboardOpenApi(document);
  applySaasPatchOpenApi(document);
  applyMonitoringContractOpenApi(document);
  applyContractHardeningOpenApi(document);
  applyResourceContractOpenApi(document);
  applyStatusContractOpenApi(document);
  applyWebhookContractOpenApi(document);
  applyErrorContractOpenApi(document);
  applyObservabilityOpenApi(document);
  return document;
}

export const openApiDocument = buildOpenApiDocument();
