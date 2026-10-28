export type DeletionEmployee = {
  _id: unknown;
  email: string;
  active: boolean;
  authorizationStatus: string;
  ownerProtected?: boolean;
  accessLevel?: string;
};
export type DeletionDependencies = {
  activeOrders: number;
  unsettledCashCents: number;
  pendingPayouts: number;
  activeReservations: number;
};
export function employeeDeletionBlocker(employee: DeletionEmployee, actorId: string, confirmationEmail: string, dependencies: DeletionDependencies): string | null {
  const email = employee.email.trim().toLowerCase();
  if (email === "rrhh.milchollos@gmail.com" || employee.ownerProtected || employee.accessLevel === "superadmin" || String(employee._id) === actorId) return "PROTECTED_ACCOUNT";
  if (confirmationEmail.trim().toLowerCase() !== email) return "CONFIRMATION_EMAIL_MISMATCH";
  if (employee.active || employee.authorizationStatus !== "revoked") return "REVOKE_ACCOUNT_BEFORE_DELETION";
  if (dependencies.activeOrders > 0) return "ACTIVE_ORDERS_BLOCK_DELETION";
  if (dependencies.unsettledCashCents !== 0) return "UNSETTLED_CASH_BLOCKS_DELETION";
  if (dependencies.pendingPayouts > 0) return "PENDING_PAYOUTS_BLOCK_DELETION";
  if (dependencies.activeReservations > 0) return "ACTIVE_RESERVATIONS_BLOCK_DELETION";
  return null;
}
