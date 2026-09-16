import "dotenv/config";

import { assertProductionSafety } from "./system/readiness.js";

assertProductionSafety({ role: "monitor" });
await import("./monitor-worker.js");
