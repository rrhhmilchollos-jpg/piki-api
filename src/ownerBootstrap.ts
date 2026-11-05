import { EmployeeAccount } from "./models.js";
import { hashPassword } from "./employeeAuth.js";

const OWNER_EMAIL = (process.env.PIKI_OWNER_EMAIL || "rrhh.milchollos@gmail.com").trim().toLowerCase();

let alreadyRan = false;

/**
 * Alta puntual de la cuenta raíz, activada por variable de entorno.
 * No registra la contraseña ni el hash en ningún log.
 */
export async function runOwnerBootstrapOnce(): Promise<void> {
  if (alreadyRan) return;
  const password = String(process.env.PIKI_BOOTSTRAP_PASSWORD || "");
  if (password.length < 12) {
    console.log("[owner-bootstrap] omitido: PIKI_BOOTSTRAP_PASSWORD ausente o demasiado corta");
    return;
  }
  alreadyRan = true;
  try {
    const before = await EmployeeAccount.findOne({ email: OWNER_EMAIL }).select("_id apiRole accessLevel active").lean();
    const passwordHash = hashPassword(password);
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
    await EmployeeAccount.updateMany(
      { email: OWNER_EMAIL, _id: { $ne: updated?._id } },
      { $set: { active: false } },
    ).exec();
    await (await import("mongoose")).default.connection
      .collection("governance_audit_events")
      .insertOne({
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
    console.log("[owner-bootstrap] ok", JSON.stringify({ email: OWNER_EMAIL, created: !before, employeeId: String(updated?._id ?? "") }));
  } catch (error) {
    console.error("[owner-bootstrap] error", error instanceof Error ? error.message : error);
  }
}
