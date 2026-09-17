import { applyCustomerDashboardOpenApi as applyBaseCustomerDashboardOpenApi } from "./customer-dashboard-openapi-base.js";

const appliedDocuments = new WeakSet();

export function applyCustomerDashboardOpenApi(document) {
  if (appliedDocuments.has(document)) return document;
  applyBaseCustomerDashboardOpenApi(document);
  appliedDocuments.add(document);
  return document;
}
