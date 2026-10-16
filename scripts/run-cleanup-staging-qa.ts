import "dotenv/config";
import { cleanupStagingQaRun } from "./cleanup-staging-qa.js";

const runId = String(process.env.E2E_RUN_ID || "").trim();
const result = await cleanupStagingQaRun(runId);
console.log(JSON.stringify(result, null, 2));
