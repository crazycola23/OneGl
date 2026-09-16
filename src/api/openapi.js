const jsonResponse = (description, schema = { type: "object" }) => ({
  description,
  content: { "application/json": { schema } },
});

const idParameter = (name, description) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "integer", minimum: 1 },
});

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "OneGl Service API",
    version: "0.1.0",
    description:
      "Server-to-server API for operating OneGl GEO measurement projects, keyword pools and batches. Browser cookies/storageState and browser-control primitives are intentionally not exposed.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          details: {},
        },
        required: ["error", "message"],
      },
      ProjectCreate: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: ["string", "null"] },
          target_brand: { type: ["string", "null"] },
          keywords: { type: "array", maxItems: 5000, items: { type: "string" } },
          category: { type: ["string", "null"] },
        },
      },
      KeywordCreate: {
        type: "object",
        required: ["keywords"],
        properties: {
          keywords: { type: "array", minItems: 1, maxItems: 5000, items: { type: "string" } },
          category: { type: ["string", "null"] },
        },
      },
      BatchCreate: {
        type: "object",
        required: ["project_id", "accounts"],
        properties: {
          project_id: { type: "integer", minimum: 1 },
          name: { type: ["string", "null"] },
          size: { type: ["integer", "null"], minimum: 1, maximum: 10000 },
          method: { type: "string", enum: ["stratified", "random"], default: "stratified" },
          seed: { type: ["string", "null"] },
          accounts: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
          repeats: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          start: {
            type: "boolean",
            default: false,
            description: "When true, enqueue the newly created batch immediately.",
          },
        },
      },
    },
    responses: {
      BadRequest: jsonResponse("Invalid request", { $ref: "#/components/schemas/Error" }),
      Unauthorized: jsonResponse("Missing or invalid API credentials", { $ref: "#/components/schemas/Error" }),
      NotFound: jsonResponse("Resource not found", { $ref: "#/components/schemas/Error" }),
      Conflict: jsonResponse("Resource cannot perform the requested operation in its current state", {
        $ref: "#/components/schemas/Error",
      }),
    },
  },
  security: [{ bearerAuth: [] }, { apiKey: [] }],
  paths: {
    "/healthz": {
      get: {
        security: [],
        summary: "Service health",
        responses: { 200: jsonResponse("Service health") },
      },
    },
    "/openapi.json": {
      get: {
        security: [],
        summary: "OpenAPI document",
        responses: { 200: jsonResponse("OpenAPI 3.1 document") },
      },
    },
    "/v1/projects": {
      get: {
        summary: "List projects",
        responses: {
          200: jsonResponse("Projects"),
          401: { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        summary: "Create a project",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectCreate" } } },
        },
        responses: {
          201: jsonResponse("Project created or existing project returned"),
          400: { $ref: "#/components/responses/BadRequest" },
          401: { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/v1/projects/{projectId}/keywords": {
      parameters: [idParameter("projectId", "Project ID")],
      get: {
        summary: "List project keywords",
        responses: {
          200: jsonResponse("Keywords"),
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
      post: {
        summary: "Add or revive project keywords",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/KeywordCreate" } } },
        },
        responses: {
          201: jsonResponse("Keyword import result"),
          400: { $ref: "#/components/responses/BadRequest" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/accounts": {
      get: {
        summary: "List execution accounts and health state",
        description: "Returns operational account state only. Session cookies/storageState are never returned.",
        responses: { 200: jsonResponse("Accounts") },
      },
    },
    "/v1/batches": {
      get: {
        summary: "List batches",
        parameters: [
          { name: "project_id", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: { 200: jsonResponse("Batches") },
      },
      post: {
        summary: "Create a sampling batch",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/BatchCreate" } } },
        },
        responses: {
          201: jsonResponse("Batch created"),
          400: { $ref: "#/components/responses/BadRequest" },
          409: { $ref: "#/components/responses/Conflict" },
          422: jsonResponse("Semantically invalid batch request", { $ref: "#/components/schemas/Error" }),
        },
      },
    },
    "/v1/batches/{batchId}": {
      parameters: [idParameter("batchId", "Batch ID")],
      get: {
        summary: "Get batch progress",
        responses: {
          200: jsonResponse("Batch progress"),
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/batches/{batchId}/start": {
      parameters: [idParameter("batchId", "Batch ID")],
      post: {
        summary: "Enqueue a batch",
        responses: {
          202: jsonResponse("Batch enqueued"),
          404: { $ref: "#/components/responses/NotFound" },
          409: { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/v1/batches/{batchId}/stop": {
      parameters: [idParameter("batchId", "Batch ID")],
      post: {
        summary: "Stop a queued/running batch",
        responses: {
          200: jsonResponse("Batch stopped"),
          404: { $ref: "#/components/responses/NotFound" },
          409: { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/v1/batches/{batchId}/runs": {
      parameters: [idParameter("batchId", "Batch ID")],
      get: {
        summary: "List runs for a batch",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
        ],
        responses: {
          200: jsonResponse("Runs"),
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/batches/{batchId}/report": {
      parameters: [idParameter("batchId", "Batch ID")],
      get: {
        summary: "Get batch analytics report",
        responses: {
          200: jsonResponse("Batch report, source aggregates and source intelligence"),
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/runs/{runId}": {
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^run_[A-Za-z0-9_-]+$" },
        },
      ],
      get: {
        summary: "Get one run with citations",
        responses: {
          200: jsonResponse("Run and citations"),
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
  },
};
