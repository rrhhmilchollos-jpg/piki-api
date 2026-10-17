import assert from "node:assert/strict";
import test from "node:test";
import { buildNoticeCopy } from "./notifications.js";

test("la notificación Customer abre el seguimiento mediante el código público", () => {
  const notice = buildNoticeCopy({
    eventId: "evt-ready",
    channel: "customer",
    audienceKey: "customer:507f1f77bcf86cd799439011",
    type: "order.status_changed",
    payload: {
      orderId: "507f1f77bcf86cd799439012",
      publicCode: "PIKI-MVBP4EQA",
      status: "ready_for_pickup",
    },
  }, {
    surface: "customer",
    ownerType: "customer",
    ownerId: "507f1f77bcf86cd799439011",
    tenantId: null,
  });

  assert.ok(notice);
  assert.equal(notice.url, "/?order_id=PIKI-MVBP4EQA");
});
