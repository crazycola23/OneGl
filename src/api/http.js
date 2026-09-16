export class ApiHttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
  return true;
}

export function sendBuffer(res, status, body, contentType = "application/octet-stream") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return true;
}

export async function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ApiHttpError(413, "payload_too_large", "request body is too large");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new ApiHttpError(400, "invalid_json", "request body must be a JSON object", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parsePositiveInt(value, name, { fallback = null, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === "") {
    if (fallback !== null) return fallback;
    throw new ApiHttpError(400, "invalid_request", `${name} is required`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new ApiHttpError(400, "invalid_request", `${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

export function stringArray(value, name, { required = false, maxItems = 1000 } = {}) {
  if (value == null) {
    if (required) throw new ApiHttpError(400, "invalid_request", `${name} is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ApiHttpError(400, "invalid_request", `${name} must be an array`);
  }
  const result = value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  if (required && !result.length) {
    throw new ApiHttpError(400, "invalid_request", `${name} must contain at least one value`);
  }
  if (result.length > maxItems) {
    throw new ApiHttpError(400, "invalid_request", `${name} may contain at most ${maxItems} values`);
  }
  return [...new Set(result)];
}

export function errorPayload(error) {
  if (error instanceof ApiHttpError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return {
    status: 500,
    body: {
      error: "internal_error",
      message: "internal server error",
      ...(process.env.NODE_ENV === "production"
        ? {}
        : { details: { message: error instanceof Error ? error.message : String(error) } }),
    },
  };
}
