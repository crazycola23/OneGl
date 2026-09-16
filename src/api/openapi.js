export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "OneGl Service API",
    version: "0.1.0",
    description: "Server-to-server API for operating OneGl GEO measurement batches. Browser session material is never exposed.",
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
        properties: { error: { type: "string" }, details: {} },
        required: ["error"],
      },
    },
  },
  security: [{ bearerAuth: [] }, { apiKey: [] }],
  paths: {},
};
