import crypto from "node:crypto";

import { ApiHttpError } from "./http.js";

const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

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

export async function claimIdempotency(pool, { tenantId, operation, key, requestHash }) {
  if (!key) return { claimed: true, record: null };
  const { rows } = await pool.query(
    `INSERT INTO service_idempotency_keys (tenant_id, operation, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING
     RETURNING *`,
    [tenantId, operation, key, requestHash],
  );
  if (rows[0]) return { claimed: true, record: rows[0] };

  const existing = (
    await pool.query(
      `SELECT * FROM service_idempotency_keys
        WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [tenantId, operation, key],
    )
  ).rows[0];
  if (!existing) throw new ApiHttpError(409, "idempotency_conflict", "idempotency key could not be resolved");
  if (existing.request_hash !== requestHash) {
    throw new ApiHttpError(409, "idempotency_conflict", "Idempotency-Key was already used with a different request body");
  }
  if (!existing.resource_id) {
    throw new ApiHttpError(409, "idempotency_in_progress", "an identical request with this Idempotency-Key is still being processed");
  }
  return { claimed: false, record: existing };
}

export async function completeIdempotency(pool, { recordId, resourceType, resourceId, responseStatus }) {
  if (!recordId) return;
  await pool.query(
    `UPDATE service_idempotency_keys
        SET resource_type = $2, resource_id = $3, response_status = $4, completed_at = now()
      WHERE id = $1`,
    [recordId, resourceType, resourceId, responseStatus],
  );
}

export async function releaseIdempotency(pool, recordId) {
  if (!recordId) return;
  await pool.query(
    "DELETE FROM service_idempotency_keys WHERE id = $1 AND resource_id IS NULL",
    [recordId],
  );
}
