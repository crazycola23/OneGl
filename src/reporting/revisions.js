import crypto from "node:crypto";

import { batchDetail } from "../db/dashboard.js";
import { getExecution, listBatchResultIdentities } from "../tasks/service.js";
import { buildReportContract, contractContentHash } from "./report-contract.js";

/**
 * Immutable report revisions.
 *
 * A revision freezes one report-contract payload. Rows are only ever inserted, never updated,
 * and `content_hash` is the sha256 of the canonical JSON of the stored payload minus the
 * fields that are volatile by construction (see `hashableContract`). That is what lets
 * `POST /v1/reports/{id}/revisions` be safely retried: an identical snapshot returns the
 * revision that already exists instead of stacking a second copy of it.
 */

function num(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function publicId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Live report contract for a `service_reports` row joined with its task/execution public ids.
 * `detail.resultIdentities` is loaded here so every collected run can echo the caller's
 * `external_id` back.
 */
export async function loadReportDetail(pool, report) {
  const batchId = Number(report.batch_id);
  const detail = await batchDetail(pool, batchId);
  detail.resultIdentities = await listBatchResultIdentities(pool, batchId);
  return detail;
}

export async function buildLiveReportContract(pool, { tenantId, report, revision = 0 }) {
  const [detail, execution] = await Promise.all([
    loadReportDetail(pool, report),
    getExecution(pool, tenantId, report.execution_public_id),
  ]);
  const generatedAt = detail.report?.batch?.finished_at
    ? new Date(detail.report.batch.finished_at).toISOString()
    : null;
  const contract = buildReportContract({
    detail,
    execution,
    report,
    revision,
    generatedAt: generatedAt ?? undefined,
  });
  return { contract, detail, execution };
}

async function latestRevision(pool, reportId) {
  const { rows } = await pool.query(
    `SELECT * FROM service_report_revisions WHERE report_id = $1 ORDER BY revision DESC LIMIT 1`,
    [reportId],
  );
  return rows[0] ?? null;
}

/**
 * @returns {{ row: object, created: boolean, replayed: boolean }}
 */
export async function createReportRevision(pool, { tenantId, report, contract, inputScope = null }) {
  const contentHash = contractContentHash(contract);
  const latest = await latestRevision(pool, report.id);
  if (latest && latest.content_hash === contentHash) {
    return { row: latest, created: false, replayed: true };
  }

  const batch = contract.summary?.batch ?? {};
  const revision = num(latest?.revision) + 1;
  const payload = { ...contract, revision };
  const scope = inputScope ?? {
    report_id: report.public_id,
    task_id: report.task_public_id ?? null,
    execution_id: report.execution_public_id ?? null,
    batch_status: batch.status ?? null,
    schema_version: contract.schema_version,
    collection_progress: contract.collection?.progress ?? null,
    analysis_status: contract.analysis?.status ?? null,
    readiness_status: contract.readiness?.status ?? null,
  };

  const { rows } = await pool.query(
    `INSERT INTO service_report_revisions
       (public_id, tenant_id, report_id, execution_id, revision, schema_version, payload, content_hash,
        input_scope, collected_until, analysis_completed_at, analysis_generation)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12)
     ON CONFLICT (report_id, revision) DO NOTHING
     RETURNING *`,
    [
      publicId("rrev"),
      tenantId,
      report.id,
      report.execution_id,
      revision,
      contract.schema_version,
      JSON.stringify(payload),
      contentHash,
      JSON.stringify(scope),
      batch.finished_at ?? null,
      contract.analysis?.finished_at ?? null,
      contract.analysis?.generation ?? null,
    ],
  );

  if (rows[0]) return { row: rows[0], created: true, replayed: false };

  // Lost a race on the same revision number: the winner's row is the caller's answer as long
  // as it hashes to the same snapshot; otherwise the caller simply retries on the next number.
  const raced = await latestRevision(pool, report.id);
  if (raced && raced.content_hash === contentHash) return { row: raced, created: false, replayed: true };
  const retry = await pool.query(
    `SELECT * FROM service_report_revisions WHERE report_id = $1 AND content_hash = $2 ORDER BY revision DESC LIMIT 1`,
    [report.id, contentHash],
  );
  if (retry.rows[0]) return { row: retry.rows[0], created: false, replayed: true };
  return { row: await latestRevision(pool, report.id), created: false, replayed: false };
}

export async function listReportRevisions(pool, { tenantId, reportId, limit = 100, cursor = null }) {
  const { rows } = await pool.query(
    `SELECT id, public_id, revision, schema_version, content_hash, input_scope, created_at,
            collected_until, analysis_completed_at, analysis_generation
       FROM service_report_revisions
      WHERE tenant_id = $1 AND report_id = $2
        AND ($3::bigint IS NULL OR id < $3)
      ORDER BY id DESC
      LIMIT $4`,
    [tenantId, reportId, cursor, limit + 1],
  );
  return rows;
}

export async function getReportRevision(pool, { tenantId, reportId, revision }) {
  const { rows } = await pool.query(
    `SELECT * FROM service_report_revisions
      WHERE tenant_id = $1 AND report_id = $2 AND revision = $3`,
    [tenantId, reportId, revision],
  );
  return rows[0] ?? null;
}

export async function getReportRevisionByPublicId(pool, { tenantId, publicId: id }) {
  const { rows } = await pool.query(
    "SELECT * FROM service_report_revisions WHERE tenant_id = $1 AND public_id = $2",
    [tenantId, id],
  );
  return rows[0] ?? null;
}

export function revisionSummary(row) {
  const scope = row.input_scope ?? {};
  return {
    revision_id: row.public_id,
    report_id: scope.report_id ?? null,
    task_id: scope.task_id ?? null,
    execution_id: scope.execution_id ?? null,
    revision: Number(row.revision),
    schema_version: row.schema_version,
    content_hash: row.content_hash,
    created_at: row.created_at,
    collected_until: row.collected_until ?? null,
    analysis_completed_at: row.analysis_completed_at ?? null,
    analysis_generation: row.analysis_generation == null ? null : Number(row.analysis_generation),
    collection_status: scope.batch_status ?? null,
    analysis_status: scope.analysis_status ?? null,
    readiness_status: scope.readiness_status ?? null,
    artifact_urls: {
      json: `/v1/reports/${scope.report_id}/revisions/${row.revision}/artifact?format=json`,
      html: `/v1/reports/${scope.report_id}/revisions/${row.revision}/artifact?format=html`,
    },
  };
}

/**
 * Resolve the SaaS report that owns a sampling batch. Internal joins stay in this module so the
 * analysis worker does not have to know anything about the service facade schema.
 */
export async function reportForBatch(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT rp.*, e.public_id AS execution_public_id, t.public_id AS task_public_id,
            b.status AS batch_status
       FROM service_reports rp
       JOIN service_task_executions e ON e.id = rp.execution_id
       JOIN service_tasks t ON t.id = e.task_id
       JOIN sampling_batches b ON b.id = rp.batch_id
      WHERE rp.batch_id = $1`,
    [batchId],
  );
  return rows[0] ?? null;
}

/**
 * Analysis-worker entry point. `notifier` is injectable so the DB-free contract tests can
 * exercise the revision pipeline without a PostgreSQL instance.
 */
export async function publishReportRevisionForBatch(
  pool,
  { batchId, log = () => undefined, notifier = publishReportRevision } = {},
) {
  const report = await reportForBatch(pool, batchId);
  if (!report) return null;
  return notifier(pool, { tenantId: Number(report.tenant_id), report, log });
}

export async function publishReportRevision(pool, { tenantId, report, log = () => undefined } = {}) {
  if (!report?.id) return null;
  const { contract } = await buildLiveReportContract(pool, { tenantId, report });
  const saved = await createReportRevision(pool, { tenantId, report, contract });
  const generation = num(contract.analysis?.generation);
  const payload = {
    report_id: report.public_id,
    task_id: report.task_public_id ?? null,
    execution_id: report.execution_public_id ?? null,
    revision: Number(saved.row.revision),
    revision_id: saved.row.public_id,
    content_hash: saved.row.content_hash,
    schema_version: saved.row.schema_version,
    analysis_generation: generation,
    analysis_status: contract.analysis?.status ?? null,
    readiness_status: contract.readiness?.status ?? null,
    created_at: saved.row.created_at,
  };
  await pool.query(
    `INSERT INTO service_webhook_events (tenant_id, event_key, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_key) DO NOTHING`,
    [
      tenantId,
      `report-revision:${report.public_id}:${generation}`,
      "report.revision.ready",
      JSON.stringify(payload),
    ],
  );
  log({
    event: "report-revision-created",
    report_id: report.public_id,
    revision: Number(saved.row.revision),
    generation,
    created: saved.created,
  });
  return { row: saved.row, contract, created: saved.created };
}
