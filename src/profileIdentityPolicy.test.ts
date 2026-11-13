import test from "node:test";
import assert from "node:assert/strict";
import { CustomerAccount, EmployeeAccount, Rider } from "./models.js";
import { PROFILE_PHOTO_MAX_CHARS, customerDeliveryIsActive, customerHasAssignedRider, employeeProfileUpdateSchema, isRasterProfilePhoto, profilePhotoSchema, publicProfilePhoto, publicRiderName, riderPublicNameUpdateSchema } from "./profileIdentityPolicy.js";
import { JPEG_PHOTO, PNG_PHOTO, WEBP_PHOTO } from "./testFixtures/profileIdentities.js";

for (const [format, photo] of [["jpeg", JPEG_PHOTO], ["png", PNG_PHOTO], ["webp", WEBP_PHOTO]]) test(`accepts canonical, signature-matched synthetic ${format}`, () => {
  assert(isRasterProfilePhoto(photo)); assert(profilePhotoSchema.safeParse(photo).success); assert.equal(publicProfilePhoto(photo), photo);
});

test("null removes avatars but omitted/unknown employee profile fields cannot mutate identity or permissions", () => {
  assert.deepEqual(employeeProfileUpdateSchema.parse({ photoUrl: null }), { photoUrl: null });
  for (const value of [{}, null, [], { photoUrl: undefined }, { photoUrl: PNG_PHOTO, role: "admin" }, { photoUrl: null, name: "Other" }, { photoUrl: null, employeeId: "other" }, { photoUrl: null, permissions: ["*"] }]) assert(!employeeProfileUpdateSchema.safeParse(value).success);
  assert(profilePhotoSchema.safeParse(null).success); assert.equal(publicProfilePhoto(null), null);
});

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64");
for (const [reason, photo] of [
  ["external URL", "https://example.test/avatar.png"], ["private path", "/api/v1/documents/identity"], ["SVG", `data:image/svg+xml;base64,${svg}`],
  ["SVG mislabeled as PNG", `data:image/png;base64,${svg}`], ["PDF", `data:application/pdf;base64,${Buffer.from("%PDF-1.7").toString("base64")}`],
  ["GIF", "data:image/gif;base64,R0lGODlh"], ["wrong MIME", PNG_PHOTO.replace("image/png", "image/jpeg")],
  ["whitespace", `${PNG_PHOTO}\n`], ["missing padding", JPEG_PHOTO.replace(/=+$/, "")], ["extra padding", `${PNG_PHOTO}=`],
  ["empty", "data:image/png;base64,"], ["truncated JPEG", JPEG_PHOTO.slice(0, -4)], ["non-string", { photoUrl: PNG_PHOTO }],
] as const) test(`rejects ${reason}`, () => { assert(!isRasterProfilePhoto(photo)); assert(!profilePhotoSchema.safeParse(photo).success); assert.equal(publicProfilePhoto(photo), null); });

test("noncanonical pad bits are rejected even when Node decodes identical raster bytes", () => {
  const encoded = JPEG_PHOTO.split(",")[1];
  assert(encoded.endsWith("="));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const pos = encoded.length - 2;
  const alternate = encoded.slice(0, pos) + alphabet[alphabet.indexOf(encoded[pos]) + 1] + "=";
  assert(Buffer.from(encoded, "base64").equals(Buffer.from(alternate, "base64")));
  assert(!isRasterProfilePhoto(`data:image/jpeg;base64,${alternate}`));
});

test("full URL limit is 220000 chars, not decoded bytes or payload alone", () => {
  const prefix = "data:image/png;base64,";
  const byteCount = Math.floor((PROFILE_PHOTO_MAX_CHARS - prefix.length) / 4) * 3;
  const image = Buffer.alloc(byteCount);
  const pixel = Buffer.from(PNG_PHOTO.split(",")[1], "base64");
  pixel.copy(image, 0, 0, 33); pixel.copy(image, image.length - 12, pixel.length - 12);
  const within = prefix + image.toString("base64");
  assert(within.length <= PROFILE_PHOTO_MAX_CHARS); assert(isRasterProfilePhoto(within));
  const larger = Buffer.concat([image.subarray(0, -12), Buffer.alloc(3), image.subarray(-12)]);
  const oversized = prefix + larger.toString("base64");
  assert(oversized.length > PROFILE_PHOTO_MAX_CHARS); assert(!profilePhotoSchema.safeParse(oversized).success);
});

test("binary magic must be exact; WebP container length and PNG IHDR/IEND must match", () => {
  const webp = Buffer.from(WEBP_PHOTO.split(",")[1], "base64"); webp[0] |= 0x80;
  assert(!isRasterProfilePhoto(`data:image/webp;base64,${webp.toString("base64")}`));
  const badSize = Buffer.from(WEBP_PHOTO.split(",")[1], "base64"); badSize.writeUInt32LE(1, 4);
  assert(!isRasterProfilePhoto(`data:image/webp;base64,${badSize.toString("base64")}`));
  const png = Buffer.from(PNG_PHOTO.split(",")[1], "base64"); png.writeUInt32BE(0, 16);
  assert(!isRasterProfilePhoto(`data:image/png;base64,${png.toString("base64")}`));
  assert(!isRasterProfilePhoto(PNG_PHOTO.slice(0, -4)));
});

test("structured public name includes only first surname initial; legacy never invents surname structure", () => {
  assert.equal(publicRiderName({ firstName: "José María", lastName: "López García", name: "PRIVATE FULL NAME" }), "José María L.");
  assert.equal(publicRiderName({ firstName: "Zoë", lastName: "álvarez" }), "Zoë Á.");
  assert.equal(publicRiderName({ name: " José María López García " }), "José");
  assert.equal(publicRiderName({ name: "María-José García" }), "María-José");
  assert.equal(publicRiderName({ firstName: "José", name: "Pablo Apellido" }), "Pablo");
  for (const name of ["", "rider@example.test", "+34612345678", "https://private.test", null]) assert.equal(publicRiderName({ name }), null);
});

test("Owner name schema permits optional structured fields/removal, not contacts, roles, arbitrary identities or blank values", () => {
  assert.deepEqual(riderPublicNameUpdateSchema.parse({ firstName: " José María ", lastName: " López García " }), { firstName: "José María", lastName: "López García" });
  assert(riderPublicNameUpdateSchema.safeParse({ firstName: null }).success);
  for (const value of [{}, { firstName: "" }, { lastName: "@secret" }, { firstName: "Name\nSurname" }, { firstName: "A".repeat(81) }, { lastName: "A".repeat(121) }, { name: "Full Name" }, { firstName: "Ana", apiRole: "admin" }]) assert(!riderPublicNameUpdateSchema.safeParse(value).success);
});

for (const status of ["pending", "confirmed", "preparing", "ready_for_pickup", "picked_up", "on_the_way"]) test(`identity follows assigned ${status}, GPS/chat only delivery phases`, () => {
  const order = { riderId: "synthetic", assignmentState: "assigned", status };
  assert(customerHasAssignedRider(order)); assert.equal(customerDeliveryIsActive(order), ["picked_up", "on_the_way"].includes(status));
});
test("identity and delivery gates clear terminal, missing, offered and released assignment", () => {
  for (const order of [{ riderId: "r", assignmentState: "assigned", status: "delivered" }, { riderId: "r", assignmentState: "assigned", status: "cancelled" }, { riderId: "r", assignmentState: "offered", status: "preparing" }, { riderId: "r", assignmentState: "unassigned", status: "on_the_way" }, { assignmentState: "assigned", status: "on_the_way" }]) {
    assert(!customerHasAssignedRider(order)); assert(!customerDeliveryIsActive(order));
  }
});

for (const [label, Model, base] of [
  ["Customer", CustomerAccount, { name: "Fixture Customer", email: "customer@example.test", passwordHash: "OFFLINE" }],
  ["Employee", EmployeeAccount, { name: "Fixture Employee", email: "employee@example.test", passwordHash: "OFFLINE", jobRole: "zone_manager", apiRole: "fleet" }],
  ["Rider", Rider, { name: "Fixture Rider", email: "rider@example.test" }],
] as const) test(`${label} schema stores nullable own avatar with maximum and real validation; no DB`, () => {
  const row = new Model(base);
  assert.equal(row.photoUrl, null); assert.equal(Model.schema.path("photoUrl").options.maxlength, 220_000);
  row.photoUrl = PNG_PHOTO; assert.equal(row.validateSync(), undefined);
  row.photoUrl = "https://private.example.test/id"; assert(row.validateSync()?.errors.photoUrl);
  row.photoUrl = "a".repeat(220_001); assert(row.validateSync()?.errors.photoUrl);
  row.photoUrl = null; assert.equal(row.validateSync(), undefined);
});
test("Rider structured name fields persist and validate; employee email remains unique", () => {
  const row = new Rider({ name: "Legacy Full Name", email: "rider@example.test", firstName: " Ana ", lastName: " López García " });
  assert.equal(row.firstName, "Ana"); assert.equal(row.lastName, "López García"); assert.equal(row.validateSync(), undefined);
  row.firstName = "@secret"; assert(row.validateSync()?.errors.firstName);
  assert.equal(EmployeeAccount.schema.path("email").options.unique, true);
});
