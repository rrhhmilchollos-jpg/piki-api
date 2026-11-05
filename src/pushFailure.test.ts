import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPushFailure } from "./push.js";

test("un token FCM dado de baja se clasifica como inválido", () => {
  assert.equal(classifyPushFailure({ code: "messaging/registration-token-not-registered" }, "fcm"), "invalid");
  assert.equal(classifyPushFailure({ code: "messaging/invalid-registration-token" }, "fcm"), "invalid");
});

test("un token de otro proyecto Firebase es un fallo de configuración, no un token caducado", () => {
  assert.equal(classifyPushFailure({ code: "messaging/mismatched-credential" }, "fcm"), "config");
});

test("un token con formato corrupto se descarta", () => {
  assert.equal(classifyPushFailure({ code: "messaging/invalid-argument" }, "fcm"), "invalid");
});

test("una caída del proveedor es un fallo transitorio", () => {
  assert.equal(classifyPushFailure({ code: "messaging/server-unavailable" }, "fcm"), "failed");
  assert.equal(classifyPushFailure({ code: "messaging/internal-error" }, "fcm"), "failed");
});

test("un problema de credenciales del servidor no cuenta como token inválido", () => {
  assert.equal(classifyPushFailure({ code: "messaging/authentication-error" }, "fcm"), "config");
  assert.equal(classifyPushFailure({ message: "FCM_NOT_CONFIGURED" }, "fcm"), "config");
});

test("en Web Push distingue suscripción caducada de error temporal", () => {
  assert.equal(classifyPushFailure({ statusCode: 410 }, "webpush"), "invalid");
  assert.equal(classifyPushFailure({ statusCode: 404 }, "webpush"), "invalid");
  assert.equal(classifyPushFailure({ statusCode: 401 }, "webpush"), "config");
  assert.equal(classifyPushFailure({ statusCode: 503 }, "webpush"), "failed");
});
