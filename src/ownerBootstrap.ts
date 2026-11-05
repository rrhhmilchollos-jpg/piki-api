import mongoose from "mongoose";
import { EmployeeAccount } from "./models.js";
import { hashPassword } from "./employeeAuth.js";

const OWNER_EMAIL = (process.env.PIKI_OWNER_EMAIL || "rrhh.milchollos@gmail.com").trim().toLowerCase();
let alreadyRan = false;

export async function runOwnerBootstrapOnce(): Promise<void> {
  if (alreadyRan) return;
  const password = String(process.env.PIKI_BOOTSTRAP_PASSWORD || "");
  if (password.length < 12) { console.log("[owner-bootstrap] omitido"); return; }
  alreadyRan = true;
  try {
    const before: any = await EmployeeAccount.findOne({ email: OWNER_EMAIL }).select("_id apiRole accessLevel active").lean().exec();
    const updated: any = await EmployeeAccount.findOneAndUpdate(
      { email: OWNER_EMAIL },
      { $set: { name: before?.name || "Iván Rubio", email: OWNER_EMAIL, jobRole: "admin", apiRole: "admin", roles: ["admin"], primaryRole: "admin", accessLevel: "superadmin", authorizationStatus: "approved", active: true, ownerProtected: true, mustChangePassword: false, passwordHash: hashPassword(password) }, $setOnInsert: { employeeCode: "PIKI-OWNER" } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean().exec();
    await EmployeeAccount.updateMany({ email: OWNER_EMAIL, _id: { $ne: updated?._id } }, { $set: { active: false } }).exec();
    console.log("[owner-bootstrap] ok", JSON.stringify({ email: OWNER_EMAIL, created: !before, employeeId: String(updated?._id ?? "") }));
  } catch (error) {
    console.error("[owner-bootstrap] error", error instanceof Error ? error.message : error);
  }
}
