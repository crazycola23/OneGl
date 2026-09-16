import "dotenv/config";

import { assertProductionSafety } from "./system/readiness.js";

assertProductionSafety({ role: "worker" });
await import("./worker.js");
