import "dotenv/config";

import { assertProductionSafety } from "./system/readiness.js";

assertProductionSafety({ role: "alert" });
await import("./alert-worker.js");
