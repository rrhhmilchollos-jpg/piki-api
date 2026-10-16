import "dotenv/config";
import { seedStagingQaRun } from "./seed-staging-qa.js";

const runId = String(process.env.E2E_RUN_ID || "").trim();
const result = await seedStagingQaRun(runId, { manifestPath: process.env.E2E_FIXTURE_MANIFEST });
console.log(JSON.stringify(result, null, 2));
