const requestIdHeader = {
  description: "Server-generated request ID. Persist it in SaaS logs for support/audit correlation.",
  schema: { type: "string", pattern: "^req_[a-f0-9]{32}$", example: "req_0123456789abcdef0123456789abcdef" },
};

const rateLimitHeaders = {
  "X-RateLimit-Limit": {
    description: "Maximum requests allowed for this credential in the current one-minute window.",
    schema: { type: "integer", minimum: 1 },
  },
  "X-RateLimit-Remaining": {
    description: "Requests remaining for this credential in the current one-minute window.",
    schema: { type: "integer", minimum: 0 },
  },
  "X-RateLimit-Reset": {
    description: "Unix timestamp (seconds) when the current rate-limit window resets.",
    schema: { type: "integer", minimum: 0 },
  },
};

function responseHeaders(existing = {}) {
  return {
    ...existing,
    "X-OneGl-Request-Id": requestIdHeader,
    ...rateLimitHeaders,
  };
}

function resolveResponse(document, response) {
  if (!response?.$ref) return structuredClone(response);
  const prefix = "#/components/responses/";
  if (!response.$ref.startsWith(prefix)) return structuredClone(response);
  const name = response.$ref.slice(prefix.length);
  const target = document.components?.responses?.[name];
  if (!target) throw new Error(`OpenAPI response reference not found: ${response.$ref}`);
  return structuredClone(target);
}

function withObservabilityHeaders(document, response) {
  const resolved = resolveResponse(document, response);
  resolved.headers = responseHeaders(resolved.headers);
  return resolved;
}

export function applyObservabilityOpenApi(document) {
  document.components ??= {};
  document.components.headers ??= {};
  Object.assign(document.components.headers, {
    OneGlRequestId: requestIdHeader,
    OneGlRateLimitLimit: rateLimitHeaders["X-RateLimit-Limit"],
    OneGlRateLimitRemaining: rateLimitHeaders["X-RateLimit-Remaining"],
    OneGlRateLimitReset: rateLimitHeaders["X-RateLimit-Reset"],
  });

  for (const [pathname, pathItem] of Object.entries(document.paths ?? {})) {
    if (pathname !== "/v1" && !pathname.startsWith("/v1/")) continue;
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (response && typeof response === "object") {
          operation.responses[status] = withObservabilityHeaders(document, response);
        }
      }
      operation.responses ??= {};
      if (!operation.responses["429"]) {
        operation.responses["429"] = {
          description: "API request rate limit exceeded.",
          headers: {
            ...responseHeaders(),
            "Retry-After": {
              description: "Seconds until the caller should retry.",
              schema: { type: "integer", minimum: 1 },
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SaasError" },
            },
          },
        };
      }
    }
  }
}
