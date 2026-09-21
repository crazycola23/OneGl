import crypto from "node:crypto";

import { ApiHttpError, readJsonBody } from "./http.js";

const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const IDEMPOTENT_POST_PATHS = [
  /^\/v1\/tasks$/,
  /^\/v1\/tasks\/tsk_[a-f0-9]+\/clone$/,
  /^\/v1\/tasks\/tsk_[a-f0-9]+\/executions$/,
  /^\/v1\/tasks\/tsk_[a-f0-9]+\/schedules$/,
  /^\/v1\/reports\/rpt_[a-f0-9]+\/revisions$/,
];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function idempotencyKeyFromRequest(req) {
  const raw = req.headers["idempotency-key"];
  if (raw == null || raw === "") return null;
  const key = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!KEY_RE.test(key)) {
    throw new ApiHttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-200 URL-safe characters");
  }
  return key;
}

export function idempotencyRequestHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value ?? null))).digest("hex");
}

export function supportsSaasIdempotency(req, pathname) {
  return req.method === "POST" && IDEMPOTENT_POST_PATHS.some((pattern) => pattern.test(pathname));
}

export async function beginSaasIdempotency(pool, { tenantId, req, pathname }) {
  const key = idempotencyKeyFromRequest(req);
  if (!key || !supportsSaasIdempotency(req, pathname)) return null;

  // readJsonBody caches the parsed body on the request, so the real route can read it again.
  const body = await readJsonBody(req);
  const requestHash = idempotencyRequestHash(body);
  const operation = `${req.method} ${pathname}`;

  const { rows } = await pool.query(
    `INSERT INTO service_idempotency_keys (tenant_id, operation, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING
     RETURNING *`,
    [tenantId, operation, key, requestHash],
  );

  if (rows[0]) {
    return {
      key,
      operation,
      recordId: Number(rows[0].id),
      replay: false,
      responseStatus: null,
      responseBody: null,
    };
  }

  const existing = (
    await pool.query(
      `SELECT * FROM service_idempotency_keys
        WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [tenantId, operation, key],
    )
  ).rows[0];

  if (!existing) {
    throw new ApiHttpError(409, "idempotency_conflict", "Idempotency-Key could not be resolved");
  }
  if (existing.request_hash !== requestHash) {
    throw new ApiHttpError(409, "idempotency_conflict", "Idempotency-Key was already used with a different request body");
  }
  if (existing.response_status == null || existing.response_body == null) {
    throw new ApiHttpError(409, "idempotency_in_progress", "an identical request with this Idempotency-Key is still being processed");
  }

  return {
    key,
    operation,
    recordId: Number(existing.id),
    replay: true,
    responseStatus: Number(existing.response_status),
    responseBody: existing.response_body,
  };
}

export async function completeSaasIdempotency(pool, context, status, payload) {
  if (!context || context.replay) return;
  await pool.query(
    `UPDATE service_idempotency_keys
        SET response_status = $2, response_body = $3::jsonb, completed_at = now()
      WHERE id = $1 AND completed_at IS NULL`,
    [context.recordId, status, JSON.stringify(payload)],
  );
}
