import assert from "node:assert/strict";
import test from "node:test";
import { buildApprovedRiderOperationalProfile } from "./riderApproval.js";

test("approved rider handoff includes operational contact details but excludes private application documents", () => {
  const source = {
    name: "  Adolfo Rider ",
    email: " MendezAdolfo5@Gmail.com ",
    phone: " 634 000 000 ",
    city: " Valencia ",
    availability: " Fines de semana ",
    vehicle: "bike",
    socialSecurityNumber: "must-not-transfer",
    documents: [{ type: "identity", contentBase64: "must-not-transfer" }],
    bankCertificate: "must-not-transfer",
  };
  const profile = buildApprovedRiderOperationalProfile(source);
  assert.deepEqual(profile, {
    name: "Adolfo Rider",
    email: "mendezadolfo5@gmail.com",
    phone: "634 000 000",
    city: "Valencia",
    availability: "Fines de semana",
    vehicle: "bike",
  });
  assert.equal("socialSecurityNumber" in profile, false);
  assert.equal("documents" in profile, false);
  assert.equal("bankCertificate" in profile, false);
});
