import { ApiHttpError, readJsonBody, sendJson } from "./http.js";
import { buildCustomerDashboard } from "./customer-dashboard.js";
import { handleMonitoringRoute } from "./monitoring-routes.js";
import { getTenantProject, requireScope, tenantOwnsBatch } from "./service-store.js";
import { loadBatchDoubaoSourceSignals, loadProjectDoubaoSourceSignals } from "../db/doubao-source-signals.js";
import {
  deleteProjectCompetitor,
  listProjectCompetitors,
  loadBatchGeoIntelligence,
  loadProjectGeoIntelligence,
  upsertProjectCompetitor,
} from "../db/geo-intelligence.js";
import { listProviderAdapters } from "../providers/index.js";

function positiveId(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiHttpError(400, "invalid_request", `${name} must be a positive integer`);
  }
  return value;
}

function intelligenceDays(url) {
  const raw = url.searchParams.get("days");
  if (raw == null || raw === "") return 30;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new ApiHttpError(400, "invalid_request", "days must be an integer between 1 and 365");
  }
  return value;
}

function dashboardQuestionLimit(url) {
  const raw = url.searchParams.get("question_limit");
  if (raw == null || raw === "") return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new ApiHttpError(400, "invalid_request", "question_limit must be an integer between 1 and 500");
  }
  return value;
}

/** Returns true when this module handled the request. */
export async function handleGeoIntelligenceRoute({ req, res, url, db, auth, tenant }) {
  if (await handleMonitoringRoute({ req, res, url, db, auth, tenant })) return true;

  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/v1/providers") {
    requireScope(auth, "projects:read");
    sendJson(res, 200, { data: listProviderAdapters() });
    return true;
  }

  const taskDashboard = pathname.match(/^\/v1\/tasks\/(tsk_[a-f0-9]+)\/dashboard$/);
  if (req.method === "GET" && taskDashboard) {
    requireScope(auth, "reports:read");
    const data = await buildCustomerDashboard(db, Number(tenant.id), taskDashboard[1], {
      days: intelligenceDays(url),
      questionLimit: dashboardQuestionLimit(url),
    });
    if (!data) throw new ApiHttpError(404, "task_not_found", "task was not found");
    sendJson(res, 200, { data });
    return true;
  }

  const competitors = pathname.match(/^\/v1\/projects\/(\d+)\/competitors$/);
  if (competitors) {
    const projectId = positiveId(competitors[1], "project_id");
    const project = await getTenantProject(db, tenant.id, projectId);
    if (!project) throw new ApiHttpError(404, "project_not_found", `project ${projectId} was not found`);

    if (req.method === "GET") {
      requireScope(auth, "projects:read");
      sendJson(res, 200, { data: await listProjectCompetitors(db, projectId) });
      return true;
    }
    if (req.method === "POST") {
      requireScope(auth, "projects:write");
      const body = await readJsonBody(req);
      if (!Array.isArray(body.aliases ?? [])) throw new ApiHttpError(400, "invalid_request", "aliases must be an array");
      if (!Array.isArray(body.domains ?? [])) throw new ApiHttpError(400, "invalid_request", "domains must be an array");
      if (!Array.isArray(body.exclude_patterns ?? [])) {
        throw new ApiHttpError(400, "invalid_request", "exclude_patterns must be an array");
      }
      try {
        sendJson(res, 201, { data: await upsertProjectCompetitor(db, projectId, body) });
      } catch (error) {
        if (error?.message === "competitor name is required") {
          throw new ApiHttpError(400, "invalid_request", error.message);
        }
        throw error;
      }
      return true;
    }
  }

  const projectIntelligence = pathname.match(/^\/v1\/projects\/(\d+)\/intelligence$/);
  if (req.method === "GET" && projectIntelligence) {
    requireScope(auth, "reports:read");
    const projectId = positiveId(projectIntelligence[1], "project_id");
    const project = await getTenantProject(db, tenant.id, projectId);
    if (!project) throw new ApiHttpError(404, "project_not_found", `project ${projectId} was not found`);
    const data = await loadProjectGeoIntelligence(db, projectId, { days: intelligenceDays(url) });
    if (!data) throw new ApiHttpError(404, "project_not_found", `project ${projectId} was not found`);
    data.sourceContent = await loadProjectDoubaoSourceSignals(db, projectId, {
      from: data.scope.from,
      to: data.scope.to,
    });
    sendJson(res, 200, { data });
    return true;
  }

  const competitor = pathname.match(/^\/v1\/projects\/(\d+)\/competitors\/(\d+)$/);
  if (req.method === "DELETE" && competitor) {
    requireScope(auth, "projects:write");
    const projectId = positiveId(competitor[1], "project_id");
    const competitorId = positiveId(competitor[2], "competitor_id");
    const project = await getTenantProject(db, tenant.id, projectId);
    if (!project) throw new ApiHttpError(404, "project_not_found", `project ${projectId} was not found`);
    if (!(await deleteProjectCompetitor(db, projectId, competitorId))) {
      throw new ApiHttpError(404, "competitor_not_found", `competitor ${competitorId} was not found`);
    }
    sendJson(res, 200, { data: { deleted: true } });
    return true;
  }

  const intelligence = pathname.match(/^\/v1\/batches\/(\d+)\/intelligence$/);
  if (req.method === "GET" && intelligence) {
    requireScope(auth, "reports:read");
    const batchId = positiveId(intelligence[1], "batch_id");
    if (!(await tenantOwnsBatch(db, tenant.id, batchId))) {
      throw new ApiHttpError(404, "batch_not_found", `batch ${batchId} was not found`);
    }
    const data = await loadBatchGeoIntelligence(db, batchId);
    if (!data) throw new ApiHttpError(404, "batch_not_found", `batch ${batchId} was not found`);
    data.sourceContent = await loadBatchDoubaoSourceSignals(db, batchId);
    sendJson(res, 200, { data });
    return true;
  }

  return false;
}
