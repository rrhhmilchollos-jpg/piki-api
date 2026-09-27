import "dotenv/config";
import mongoose from "mongoose";
import { runTenantMigration } from "../src/tenantMigration.js";

const apply = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", message: "Use --apply to execute the migration. Render production execution uses RUN_TENANT_MIGRATION=true." }, null, 2));
    return;
  }
  if (process.env.ALLOW_TENANT_MIGRATION !== "true") throw new Error("Refusing to apply migration. Set ALLOW_TENANT_MIGRATION=true explicitly.");
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB || "piki", serverSelectionTimeoutMS: 15_000 });
  console.log(JSON.stringify({ mode: "apply", ...(await runTenantMigration()) }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); });
