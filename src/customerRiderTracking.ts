import { EmployeeAccount, Rider } from "./models.js";
import { customerHasAssignedRider, publicProfilePhoto, publicRiderName } from "./profileIdentityPolicy.js";

export const CUSTOMER_RIDER_PROJECTION = "_id tenantId name firstName lastName email vehicle photoUrl location lastLocationAt";
export type CustomerRiderIdentity = { riderId: string | null; riderName: string | null; riderPhotoUrl: string | null; vehicle: string | null };
const emptyIdentity = (): CustomerRiderIdentity => ({ riderId: null, riderName: null, riderPhotoUrl: null, vehicle: null });

/** Call only after authenticating the customer and loading their owned order. */
export async function customerAssignedRider(order: { riderId?: unknown; tenantId?: unknown; assignmentState?: unknown; status?: unknown }): Promise<{ identity: CustomerRiderIdentity; rider: any }> {
  if (!customerHasAssignedRider(order) || !order.tenantId) return { identity: emptyIdentity(), rider: null };
  const rider = await Rider.findOne({ _id: order.riderId, tenantId: order.tenantId })
    .select(CUSTOMER_RIDER_PROJECTION).lean().exec() as any;
  // Fail closed even if an adapter returns an unscoped or stale record.
  if (!rider || String(rider._id) !== String(order.riderId) || String(rider.tenantId) !== String(order.tenantId)) {
    return { identity: emptyIdentity(), rider: null };
  }
  let photoUrl = publicProfilePhoto(rider.photoUrl);
  if (!photoUrl && typeof rider.email === "string" && rider.email && rider.email === rider.email.trim().toLowerCase()) {
    // Email is globally unique in EmployeeAccount. No fuzzy match, phone match,
    // unscoped findById, KYC, or fallback to another tenant/unauthorized account.
    const employees = await EmployeeAccount.find({ email: rider.email, tenantId: order.tenantId })
      .select("_id tenantId email active authorizationStatus photoUrl").limit(2).lean().exec() as any[];
    const employee = employees.length === 1 ? employees[0] : null;
    if (employee && employee.email === rider.email && String(employee.tenantId) === String(order.tenantId)
      && employee.active === true && employee.authorizationStatus === "approved") {
      photoUrl = publicProfilePhoto(employee.photoUrl);
    }
  }
  return {
    rider,
    identity: { riderId: String(rider._id), riderName: publicRiderName(rider), riderPhotoUrl: photoUrl, vehicle: rider.vehicle || null },
  };
}
