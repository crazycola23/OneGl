import { parseLimit } from "./contracts.js";
import { ApiHttpError, readJsonBody, sendJson } from "./http.js";
import { getTenantProject, requireScope, resolveTenantAccountKeys } from "./service-store.js";
import {
  MonitorPlanValidationError,
  createMonitorPlan,
  deleteMonitorPlan,
  getMonitorPlan,
  listMonitorExecutions,
  listMonitorPlans,
  updateMonitorPlan,
} from "../monitoring/plans.js";

function positiveId(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiHttpError(400, "invalid_request", `${name} must be a positive integer`);
  }
  return value;
}

async function validateAccounts(db, tenantId, accounts) {
  if (accounts === undefined) return;
  if (!Array.isArray(accounts)) throw new ApiHttpError(400, "invalid_request", "accounts must be an array");
  await resolveTenantAccountKeys(db, tenantId, accounts);
}

async function writePlan(action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof MonitorPlanValidationError) {
      throw new ApiHttpError(400, "invalid_request", error.message);
    }
    if (error?.code === "23505") {
      throw new ApiHttpError(409, "monitor_plan_conflict", "a monitoring plan with this name already exists for the project");
    }
    throw error;
  }
}

/** Returns true when this module handled the request. */
export async function handleMonitoringRoute({ req, res, url, db, auth, tenant }) {
  const pathname = url.pathname;

  const projectPlans = pathname.match(/^\/v1\/projects\/(\d+)\/monitor-plans$/);
  if (projectPlans) {
    const projectId = positiveId(projectPlans[1], "project_id");
    const project = await getTenantProject(db, tenant.id, projectId);
    if (!project) throw new ApiHttpError(404, "project_not_found", `project ${projectId} was not found`);

    if (req.method === "GET") {
      requireScope(auth, "batches:read");
      return sendJson(res, 200, { data: await listMonitorPlans(db, tenant.id, projectId) });
    }
    if (req.method === "POST") {
      requireScope(auth, "batches:write");
      const body = await readJsonBody(req);
      await validateAccounts(db, tenant.id, body.accounts);
      const plan = await writePlan(() => createMonitorPlan(db, {
        tenantId: tenant.id,
        projectId,
        input: body,
      }));
      return sendJson(res, 201, { data: plan });
    }
  }

  const planRoute = pathname.match(/^\/v1\/monitor-plans\/(\d+)$/);
  if (planRoute) {
    const planId = positiveId(planRoute[1], "monitor_plan_id");
    const existing = await getMonitorPlan(db, tenant.id, planId);
    if (!existing) throw new ApiHttpError(404, "monitor_plan_not_found", `monitor plan ${planId} was not found`);

    if (req.method === "GET") {
      requireScope(auth, "batches:read");
      return sendJson(res, 200, { data: existing });
    }
    if (req.method === "PATCH") {
      requireScope(auth, "batches:write");
      const body = await readJsonBody(req);
      await validateAccounts(db, tenant.id, body.accounts);
      const plan = await writePlan(() => updateMonitorPlan(db, {
        tenantId: tenant.id,
        planId,
        input: body,
      }));
      return sendJson(res, 200, { data: plan });
    }
    if (req.method === "DELETE") {
      requireScope(auth, "batches:write");
      await deleteMonitorPlan(db, tenant.id, planId);
      return sendJson(res, 200, { data: { deleted: true } });
    }
  }

  const executions = pathname.match(/^\/v1\/monitor-plans\/(\d+)\/executions$/);
  if (req.method === "GET" && executions) {
    requireScope(auth, "batches:read");
    const planId = positiveId(executions[1], "monitor_plan_id");
    const plan = await getMonitorPlan(db, tenant.id, planId);
    if (!plan) throw new ApiHttpError(404, "monitor_plan_not_found", `monitor plan ${planId} was not found`);
    const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
    return sendJson(res, 200, { data: await listMonitorExecutions(db, tenant.id, planId, limit) });
  }

  return false;
}
