import assert from "node:assert/strict";
import test from "node:test";
import { partnerBasicProfileSchema } from "./partnerProfilePolicy.js";

test("rechaza commissionRateBps en cualquier payload de perfil Partner", () => {
  const result = partnerBasicProfileSchema.safeParse({ phone: "600000000", commissionRateBps: 500 });
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some((issue) => issue.code === "unrecognized_keys" && issue.keys.includes("commissionRateBps")));
});

test("rechaza también commissionPercent aunque se envíe como porcentaje visible", () => {
  const result = partnerBasicProfileSchema.safeParse({ commissionPercent: 5 });
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some((issue) => issue.code === "unrecognized_keys" && issue.keys.includes("commissionPercent")));
});

test("acepta únicamente los datos básicos permitidos al Partner", () => {
  const result = partnerBasicProfileSchema.safeParse({
    name: "Eleven Burgers Xàtiva",
    email: "hola@elevenburgers.es",
    phone: "613238688",
    address: "C. Juglares, 1",
    locality: "Xàtiva",
    cuisine: "Hamburguesas",
    category: "Hamburguesas",
  });
  assert.equal(result.success, true);
});
