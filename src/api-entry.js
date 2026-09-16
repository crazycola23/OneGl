import "dotenv/config";

import { assertProductionSafety } from "./system/readiness.js";

assertProductionSafety({ role: "api" });
await import("./api-server.js");
