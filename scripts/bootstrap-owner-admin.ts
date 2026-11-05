#!/usr/bin/env node
/**
 * Alta o reparación de la cuenta raíz de PIKI.
 *
 * Uso (dentro del entorno de Render, donde vive MONGODB_URI):
 *   PIKI_OWNER_PASSWORD='...' npx tsx scripts/bootstrap-owner-admin.ts
 *
 * - No imprime la contraseña ni el hash.
 * - Es idempotente: si la cuenta existe, actualiza rol, estado y contraseña.
 * - Deja rastro en governance_audit_events.
 */
import mongoose from "mongoose";
import { EmployeeAccount } from "../src/models.js";
import { hashPassword } from "../src/employeeAuth.js";

const OWNER_EMAIL = (process.env.PIKI_OWNER_EMAIL || "rrhh.milchollos@gmail.com").trim().toLowerCase();
const PASSWORD = process.env.PIKI_OWNER_PASSWORD || "";

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL || "";
  if (!uri) throw new Error("Falta MONGODB_URI en el entorno.");
  if (PASSWORD.length < 10) throw new Error("PIKI_OWNER_PASSWORD debe tener al menos 10 caracteres.");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const passwordHash = hashPassword(PASSWORD);
  const before = await EmployeeAccount.findOne({ email: OWNER_EMAIL }).select("_id name apiRole roles accessLevel authorizationStatus active").lean();

  const updated = await EmployeeAccount.findOneAndUpdate(
    { email: OWNER_EMAIL },
    {
      $set: {
        name: before?.name || "Iván Rubio",
        email: OWNER_EMAIL,
        jobRole: "admin",
        apiRole: "admin",
        roles: ["admin"],
        primaryRole: "admin",
        accessLevel: "superadmin",
        authorizationStatus: "approved",
        active: true,
        ownerProtected: true,
        mustChangePassword: false,
        passwordHash,
      },
      $setOnInsert: { employeeCode: "PIKI-OWNER" },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  await mongoose.connection.db?.collection("governance_audit_events").insertOne({
    actorEmployeeId: updated?._id ?? null,
    actorRole: "admin",
    action: before ? "owner_password_reset" : "owner_bootstrapped",
    targetType: "employee",
    targetId: updated?._id ?? null,
    before: before ? { apiRole: before.apiRole, active: before.active } : null,
    after: { apiRole: "admin", accessLevel: "superadmin", active: true },
    reason: "Alta de la cuenta raíz para operar el panel y lanzar la prueba E2E",
    createdAt: new Date(),
  });

  console.log(JSON.stringify({
    ok: true,
    created: !before,
    email: OWNER_EMAIL,
    employeeId: String(updated?._id ?? ""),
    apiRole: "admin",
    accessLevel: "superadmin",
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
