import assert from "node:assert/strict";
import test from "node:test";
import { checkoutOrigin } from "./checkoutOrigin.js";

test("acepta solo orígenes canónicos de producción", () => {
  assert.equal(checkoutOrigin("https://app.pikidelivery.com/path"), "https://pikidelivery.com");
  assert.equal(checkoutOrigin("https://app.pikidelivery.com"), "https://app.pikidelivery.com");
  assert.equal(checkoutOrigin("https://www.pikidelivery.com/"), "https://www.pikidelivery.com");
});

test("rechaza previews Vercel y dominios que imitan Piki y usa fallback canónico", () => {
  const env = { NODE_ENV: "production", CUSTOMER_APP_URL: "https://app.pikidelivery.com" } as NodeJS.ProcessEnv;
  assert.equal(checkoutOrigin("https://piki-customer-git-branch.vercel.app", env), "https://app.pikidelivery.com");
  assert.equal(checkoutOrigin("https://pikidelivery.com.attacker.example", env), "https://app.pikidelivery.com");
  assert.equal(checkoutOrigin("javascript:alert(1)", env), "https://app.pikidelivery.com");
});

test("permite un origen de staging solo si se declara explícitamente", () => {
  const env = {
    NODE_ENV: "production",
    CUSTOMER_APP_URL: "https://app.pikidelivery.com",
    CUSTOMER_CHECKOUT_ALLOWED_ORIGINS: "https://piki-customer-staging.example.com",
  } as NodeJS.ProcessEnv;
  assert.equal(checkoutOrigin("https://piki-customer-staging.example.com", env), "https://piki-customer-staging.example.com");
  assert.equal(checkoutOrigin("https://other.vercel.app", env), "https://app.pikidelivery.com");
});

test("no acepta valores de configuración de fallback con rutas o esquemas inseguros", () => {
  const env = { NODE_ENV: "production", CUSTOMER_APP_URL: "http://evil.example/path" } as NodeJS.ProcessEnv;
  assert.equal(checkoutOrigin("https://attacker.example", env), "https://pikidelivery.com");
});
