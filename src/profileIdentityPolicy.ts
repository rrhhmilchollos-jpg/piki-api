import { z } from "zod";

export const PROFILE_PHOTO_MAX_CHARS = 220_000;

/** Only explicit profile avatars enter this channel; never inspect KYC documents. */
export function isRasterProfilePhoto(value: unknown): value is string {
  if (typeof value !== "string" || value.length > PROFILE_PHOTO_MAX_CHARS) return false;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const [, type, encoded] = match;
  if (encoded.length % 4 !== 0) return false;
  const bytes = Buffer.from(encoded, "base64");
  // Node's base64 decoder is permissive, so require an exact canonical round trip.
  if (bytes.toString("base64") !== encoded) return false;
  if (type === "jpeg") {
    const marker = bytes[3];
    return bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && ((marker >= 0xe0 && marker <= 0xef) || [0xdb, 0xc0, 0xc1, 0xc2, 0xc4, 0xdd].includes(marker))
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (type === "png") {
    return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).equals(Buffer.from("IHDR"))
      && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
      && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  }
  return bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from("RIFF"))
    && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.subarray(8, 12).equals(Buffer.from("WEBP"))
    && ["VP8 ", "VP8L", "VP8X"].some((chunk) => bytes.subarray(12, 16).equals(Buffer.from(chunk)))
    && bytes.readUInt32LE(16) > 0 && bytes.readUInt32LE(16) <= bytes.length - 20;
}

export const profilePhotoSchema = z.string().max(PROFILE_PHOTO_MAX_CHARS)
  .refine(isRasterProfilePhoto, "INVALID_PROFILE_PHOTO").nullable();
export const employeeProfileUpdateSchema = z.object({ photoUrl: profilePhotoSchema }).strict();
export function publicProfilePhoto(value: unknown): string | null {
  return isRasterProfilePhoto(value) ? value : null;
}

const namePartPattern = /^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+)*$/u;
export const riderFirstNameSchema = z.string().trim().min(1).max(80).regex(namePartPattern).nullable().optional();
export const riderLastNameSchema = z.string().trim().min(1).max(120).regex(namePartPattern).nullable().optional();
export const riderPublicNameUpdateSchema = z.object({ firstName: riderFirstNameSchema, lastName: riderLastNameSchema })
  .strict().refine((value) => Object.keys(value).length > 0, "PROFILE_FIELDS_REQUIRED");

export const riderAdminProfileUpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  firstName: riderFirstNameSchema,
  lastName: riderLastNameSchema,
  phone: z.string().trim().max(40).optional(),
  city: z.string().trim().max(120).optional(),
  availability: z.string().trim().max(160).optional(),
  vehicle: z.enum(["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"]).optional(),
  fleetId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional(),
  zoneSlug: z.string().trim().max(80).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "PROFILE_FIELDS_REQUIRED");

export function publicRiderName(rider: { name?: unknown; firstName?: unknown; lastName?: unknown }): string | null {
  const firstName = typeof rider.firstName === "string" ? rider.firstName.trim() : "";
  const lastName = typeof rider.lastName === "string" ? rider.lastName.trim() : "";
  if (firstName && firstName.length <= 80 && namePartPattern.test(firstName)
    && lastName && lastName.length <= 120 && namePartPattern.test(lastName)) {
    return `${firstName} ${Array.from(lastName)[0].toLocaleUpperCase("es")}.`;
  }
  // A legacy full name does not prove where surnames start. Never infer them.
  const token = typeof rider.name === "string" ? rider.name.trim().split(/\s+/u)[0] : "";
  return token && token.length <= 80 && namePartPattern.test(token) ? token : null;
}

export function customerHasAssignedRider(order: { riderId?: unknown; assignmentState?: unknown; status?: unknown }): boolean {
  return Boolean(order.riderId) && order.assignmentState === "assigned" && !["delivered", "cancelled"].includes(String(order.status));
}
export function customerDeliveryIsActive(order: { riderId?: unknown; assignmentState?: unknown; status?: unknown }): boolean {
  return customerHasAssignedRider(order) && ["picked_up", "on_the_way"].includes(String(order.status));
}
