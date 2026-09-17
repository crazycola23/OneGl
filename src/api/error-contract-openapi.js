const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });

export function applyErrorContractOpenApi(document) {
  document.components.responses.UnprocessableEntity ??= {
    description: "Request is syntactically valid but violates a supported value or business validation rule",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
  };

  const mappings = [
    ["/v1/accounts", "post", "422", "UnprocessableEntity"],
    ["/v1/webhooks", "post", "422", "UnprocessableEntity"],
    ["/v1/batches", "post", "422", "UnprocessableEntity"],
    ["/v1/auth-sessions/{authSessionId}/screenshot", "get", "409", "Conflict"],
    ["/v1/batches/{batchId}/stop", "post", "409", "Conflict"],
    ["/v1/projects/{projectId}/monitor-plans", "post", "409", "Conflict"],
    ["/v1/monitor-plans/{monitorPlanId}", "patch", "409", "Conflict"],
  ];

  for (const [pathname, method, status, component] of mappings) {
    const responses = document.paths?.[pathname]?.[method]?.responses;
    if (responses) responses[status] ??= responseRef(component);
  }

  return document;
}
