import "dotenv/config";
import mongoose from "mongoose";
import { AccessAuthorization, EmployeeAccount } from "../src/models.js";

const apply = process.argv.includes("--apply");
const databaseName = process.env.MONGODB_DB || "piki";
const ownerEmail = String(process.env.OWNER_EMAIL || "rrhh.milchollos@gmail.com").trim().toLowerCase();

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  if (apply && process.env.ALLOW_AUTHORIZATION_MIGRATION !== "true") {
    throw new Error("Refusing to change authorizations. Set ALLOW_AUTHORIZATION_MIGRATION=true explicitly.");
  }

  await mongoose.connect(uri, { dbName: databaseName, serverSelectionTimeoutMS: 15_000 });
  const [owner, missingStatus, approvedWithoutAudit] = await Promise.all([
    EmployeeAccount.findOne({ email: ownerEmail }).select("_id email").lean().exec() as Promise<any>,
    EmployeeAccount.find({ authorizationStatus: { $exists: false } }).select("_id email apiRole accessLevel createdAt").lean().exec() as Promise<any[]>,
    EmployeeAccount.find({ email: { $ne: ownerEmail }, authorizationStatus: "approved", authorizedAt: null }).select("_id email apiRole accessLevel createdAt").lean().exec() as Promise<any[]>,
  ]);

  const summary = {
    mode: apply ? "apply" : "dry-run",
    database: databaseName,
    missingAuthorizationStatus: missingStatus.length,
    approvedWithoutAuditMetadata: approvedWithoutAudit.length,
    ownerFound: Boolean(owner),
  };
  console.log(JSON.stringify({ event: "authorization_migration_plan", ...summary }));
  if (!apply) {
    console.log(JSON.stringify({ message: "No data changed. Re-run with --apply and ALLOW_AUTHORIZATION_MIGRATION=true after completing a backup." }));
    return;
  }
  if (!owner?._id) throw new Error("Protected owner account is required to attribute legacy approvals");

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const employee of missingStatus) {
        const authorizedAt = employee.createdAt || new Date();
        const updated = await EmployeeAccount.updateOne(
          { _id: employee._id, authorizationStatus: { $exists: false } },
          {
            $set: {
              authorizationStatus: "approved",
              accessLevel: employee.accessLevel || "subadmin",
              authorizedAt,
              authorizedBy: owner._id,
              authorizationReason: "Migración explícita de autorización heredada.",
            },
          },
          { session },
        ).exec();
        if (updated.modifiedCount !== 1) continue;
        await AccessAuthorization.create([{
          employeeId: employee._id,
          action: "created",
          previousStatus: null,
          nextStatus: "approved",
          previousRole: null,
          nextRole: employee.apiRole,
          accessLevel: employee.accessLevel || "subadmin",
          actorEmployeeId: owner._id,
          reason: "Migración explícita de autorización heredada.",
        }], { session });
      }
      for (const employee of approvedWithoutAudit) {
        const authorizedAt = employee.createdAt || new Date();
        const updated = await EmployeeAccount.updateOne(
          { _id: employee._id, authorizationStatus: "approved", authorizedAt: null },
          {
            $set: {
              authorizedAt,
              authorizedBy: owner._id,
              authorizationReason: "Migración explícita de aprobación heredada.",
            },
          },
          { session },
        ).exec();
        if (updated.modifiedCount !== 1) continue;
        if (!(await AccessAuthorization.exists({ employeeId: employee._id }).session(session))) {
          await AccessAuthorization.create([{
            employeeId: employee._id,
            action: "created",
            previousStatus: null,
            nextStatus: "approved",
            previousRole: null,
            nextRole: employee.apiRole,
            accessLevel: employee.accessLevel || "subadmin",
            actorEmployeeId: owner._id,
            reason: "Migración explícita de aprobación heredada.",
          }], { session });
        }
      }
    });
    console.log(JSON.stringify({ event: "authorization_migration_completed", ...summary }));
  } finally {
    await session.endSession();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
