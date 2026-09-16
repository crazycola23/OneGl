import "dotenv/config";

import { installApiObservability } from "./api/observability.js";
import { applyObservabilityOpenApi } from "./api/observability-openapi.js";
import { assertProductionSafety } from "./system/readiness.js";

assertProductionSafety({ role: "api" });
installApiObservability();
await import("./api-server.js");
const { openApiDocument } = await import("./api/openapi.js");
applyObservabilityOpenApi(openApiDocument);
