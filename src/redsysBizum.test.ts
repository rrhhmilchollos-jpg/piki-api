import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { buildBizumPaymentForm, parseRedsysNotification, redsysOrderNumber, redsysResponseAuthorized, verifyRedsysSignature, BIZUM_PAYMETHOD, signRedsysParameters } from "./redsysBizum.js";

const key = crypto.randomBytes(24).toString("base64");

test("el formulario activa Bizum con paymethods z", () => {
  const form = buildBizumPaymentForm({ merchantCode: "123456789", terminal: 1, order: "PIKI0001", amountCents: 1990, secretKey: key });
  assert.equal(form.url, "https://sis.redsys.es/sis/realizarPago");
  assert.equal(form.fields.Ds_SignatureVersion, "HMAC_SHA256_V1");
  const decoded = JSON.parse(Buffer.from(form.fields.Ds_MerchantParameters, "base64").toString("utf8"));
  assert.equal(decoded.DS_MERCHANT_PAYMETHODS, BIZUM_PAYMETHOD);
  assert.equal(decoded.DS_MERCHANT_AMOUNT, "1990");
  assert.equal(verifyRedsysSignature(form.fields.Ds_MerchantParameters, form.fields.Ds_Signature, key), true);
});

test("un importe distinto invalida la firma", () => {
  const form = buildBizumPaymentForm({ merchantCode: "1", terminal: 1, order: "PIKI0002", amountCents: 500, secretKey: key });
  const tampered = Buffer.from(JSON.stringify({ DS_MERCHANT_AMOUNT: "999999" })).toString("base64");
  assert.equal(verifyRedsysSignature(tampered, form.fields.Ds_Signature, key), false);
});

test("solo las respuestas por debajo de 100 son autorizadas", () => {
  assert.equal(redsysResponseAuthorized("0000"), true);
  assert.equal(redsysResponseAuthorized("0099"), true);
  assert.equal(redsysResponseAuthorized("0190"), false);
  assert.equal(redsysResponseAuthorized("SIS0054"), false);
});

test("la notificación con firma válida se interpreta y con firma mala se rechaza", () => {
  const payload = Buffer.from(JSON.stringify({ Ds_Order: "PIKI0003", Ds_Response: "0000", Ds_Amount: "1990" })).toString("base64");
  const good = parseRedsysNotification({ Ds_MerchantParameters: payload, Ds_Signature: signRedsysParameters(payload, key) }, key);
  assert.equal(good.ok, true);
  assert.equal(good.ok === true && good.authorized, true);
  const bad = parseRedsysNotification({ Ds_MerchantParameters: payload, Ds_Signature: "AAAA" }, key);
  assert.equal(bad.ok, false);
});

test("el número de pedido cabe en el formato de Redsys", () => {
  const order = redsysOrderNumber("PIKI-MZ1K9QW2-EXTRA");
  assert.match(order, /^[A-Za-z0-9]{4,12}$/);
});
