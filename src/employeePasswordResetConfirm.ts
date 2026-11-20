import { createHash } from "node:crypto";

export type PasswordResetSession = {
  withTransaction(fn: () => Promise<void>, options?: any): Promise<unknown>;
  endSession(): Promise<unknown>;
};
export type PasswordResetConfirmDependencies = {
  startSession(): Promise<PasswordResetSession>;
  findReset(tokenHash: string, now: Date, session: PasswordResetSession): Promise<any>;
  findEmployee(employeeId: unknown, session: PasswordResetSession): Promise<any>;
  validateEmployee(employee: any, surface: string, session: PasswordResetSession): Promise<boolean>;
  claimReset(reset: any, tokenHash: string, now: Date, session: PasswordResetSession): Promise<boolean>;
  savePassword(employee: any, password: string, now: Date, session: PasswordResetSession): Promise<unknown>;
  revokeEmployeeSessions(employeeId: unknown, session: PasswordResetSession): Promise<unknown>;
  now?: () => Date;
};
class InvalidReset extends Error {}
export type PasswordResetConfirmResult = { status: number; body: { changed: true } | { error: string; message: string } };
const invalid = (): PasswordResetConfirmResult => ({ status: 400, body: { error: "PASSWORD_RESET_INVALID", message: "El enlace no es válido para esta aplicación, ya se utilizó o ha caducado. Solicita un nuevo enlace en la aplicación correcta." } });

/** No mail, logging or non-transactional fallback. The driver retries transient
 * conflicts; every retry re-reads and revalidates before the single-use CAS.
 */
export async function confirmEmployeePasswordReset(input: { token: string; newPassword: string; surface: string }, deps: PasswordResetConfirmDependencies): Promise<PasswordResetConfirmResult> {
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  let session: PasswordResetSession | undefined;
  try {
    let completed = false;
    session = await deps.startSession();
    await session.withTransaction(async () => {
      completed = false;
      const now = deps.now?.() || new Date();
      const reset = await deps.findReset(tokenHash, now, session!);
      if (!reset || reset.usedAt || !Number.isFinite(new Date(reset.expiresAt).getTime()) || new Date(reset.expiresAt) <= now || (reset.surface && reset.surface !== input.surface)) throw new InvalidReset();
      const employee = await deps.findEmployee(reset.employeeId, session!);
      if (!employee || employee.active !== true || employee.authorizationStatus !== "approved"
        || (reset.email && String(reset.email).trim().toLowerCase() !== String(employee.email).trim().toLowerCase())
        || !await deps.validateEmployee(employee, input.surface, session!)) throw new InvalidReset();
      // All eligibility checks precede writes; all writes share this session.
      if (!await deps.claimReset(reset, tokenHash, now, session!)) throw new InvalidReset();
      await deps.savePassword(employee, input.newPassword, now, session!);
      await deps.revokeEmployeeSessions(employee._id, session!);
      completed = true;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
    if (!completed) throw new Error("PASSWORD_RESET_TRANSACTION_NOT_COMPLETED");
    return { status: 200, body: { changed: true } };
  } catch (error) {
    if (error instanceof InvalidReset) return invalid();
    // Includes standalone Mongo, session/commit errors and failed credential or
    // session writes. Never consume a token through an unsafe fallback.
    return { status: 503, body: { error: "PASSWORD_RESET_UNAVAILABLE", message: "No se pudo confirmar el cambio de contraseña de forma segura. Inténtalo de nuevo más tarde; si el enlace deja de ser válido, solicita otro." } };
  } finally {
    if (session) { try { await session.endSession(); } catch { /* Cleanup cannot undo a successful commit or expose database errors. */ } }
  }
}
