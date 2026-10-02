import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeLeadEmail,
  partnerLeadSubmissionSchema,
  riderLeadSubmissionSchema,
  webLeadReviewSchema,
} from "./webLeads.js";

test("partner lead accepts the minimal public contact request", () => {
  const result = partnerLeadSubmissionSchema.safeParse({
    name: "Restaurante Demo",
    email: "VENTAS@EXAMPLE.ES",
    phone: "+34 600 000 000",
    address: "Calle Mayor 1",
    city: "Xàtiva",
    privacyNoticeAccepted: true,
  });
  assert.equal(result.success, true);
  if (result.success) assert.equal(normalizeLeadEmail(result.data.email), "ventas@example.es");
});

test("rider lead requires a privacy acknowledgement and valid application basics", () => {
  const valid = riderLeadSubmissionSchema.safeParse({
    name: "Adolfo Mendez",
    email: "mendezadolfo5@gmail.com",
    phone: "+34 600 000 000",
    city: "Xàtiva",
    vehicle: "electric_bike",
    availability: "Tardes",
    privacyNoticeAccepted: true,
  });
  const withoutPrivacy = riderLeadSubmissionSchema.safeParse({
    name: "Adolfo Mendez",
    email: "mendezadolfo5@gmail.com",
    phone: "+34 600 000 000",
    city: "Xàtiva",
    vehicle: "electric_bike",
    availability: "Tardes",
  });
  assert.equal(valid.success, true);
  assert.equal(withoutPrivacy.success, false);
});

test("lead review only accepts supported states and notes are bounded", () => {
  assert.equal(webLeadReviewSchema.safeParse({ status: "info_requested", notes: "Enviar CIF" }).success, true);
  assert.equal(webLeadReviewSchema.safeParse({ status: "approved" }).success, false);
  assert.equal(webLeadReviewSchema.safeParse({ status: "info_requested", notes: "x".repeat(1001) }).success, false);
});
