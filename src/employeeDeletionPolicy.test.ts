import test from "node:test";
import assert from "node:assert/strict";
import { employeeDeletionBlocker } from "./employeeDeletionPolicy.js";
const employee = { _id: "target", email: "target@example.test", active: false, authorizationStatus: "revoked", accessLevel: "subadmin" };
const clear = { activeOrders: 0, unsettledCashCents: 0, pendingPayouts: 0, activeReservations: 0 };
test("permanent deletion only accepts exact revoked inactive employee", () => {
  assert.equal(employeeDeletionBlocker(employee, "actor", employee.email, clear), null);
  assert.equal(employeeDeletionBlocker(employee, "actor", "wrong@example.test", clear), "CONFIRMATION_EMAIL_MISMATCH");
  assert.equal(employeeDeletionBlocker({ ...employee, active: true }, "actor", employee.email, clear), "REVOKE_ACCOUNT_BEFORE_DELETION");
  assert.equal(employeeDeletionBlocker({ ...employee, authorizationStatus: "suspended" }, "actor", employee.email, clear), "REVOKE_ACCOUNT_BEFORE_DELETION");
});
test("owner, self and protected superadmin can never be deleted", () => {
  for (const target of [{ ...employee, email: "rrhh.milchollos@gmail.com" }, { ...employee, ownerProtected: true }, { ...employee, accessLevel: "superadmin" }]) {
    assert.equal(employeeDeletionBlocker(target, "actor", target.email, clear), "PROTECTED_ACCOUNT");
  }
  assert.equal(employeeDeletionBlocker(employee, "target", employee.email, clear), "PROTECTED_ACCOUNT");
});
test("operational and financial dependencies block irreversible deletion", () => {
  assert.equal(employeeDeletionBlocker(employee, "actor", employee.email, { ...clear, activeOrders: 1 }), "ACTIVE_ORDERS_BLOCK_DELETION");
  assert.equal(employeeDeletionBlocker(employee, "actor", employee.email, { ...clear, unsettledCashCents: 1 }), "UNSETTLED_CASH_BLOCKS_DELETION");
  assert.equal(employeeDeletionBlocker(employee, "actor", employee.email, { ...clear, unsettledCashCents: -1 }), "UNSETTLED_CASH_BLOCKS_DELETION");
  assert.equal(employeeDeletionBlocker(employee, "actor", employee.email, { ...clear, pendingPayouts: 1 }), "PENDING_PAYOUTS_BLOCK_DELETION");
  assert.equal(employeeDeletionBlocker(employee, "actor", employee.email, { ...clear, activeReservations: 1 }), "ACTIVE_RESERVATIONS_BLOCK_DELETION");
});
