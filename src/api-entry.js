import "dotenv/config";

import { installApiObservability } from "./api/observability.js";
import { assertProductionSafety } from "./system/readiness.js";

assertProductionSafety({ role: "api" });
installApiObservability();
await import("./api-server.js");
