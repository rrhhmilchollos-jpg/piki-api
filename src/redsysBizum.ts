import crypto from "node:crypto";

/**
 * Pago con Bizum a través del TPV Virtual de Redsys.
 *
 * Redsys no expone un API distinto para Bizum: se usa la redirección de
 * siempre y se marca `Ds_Merchant_Paymethods` con la letra `z`. El TPV hace
 * toda la autorización, de modo que la conciliación deja de ser manual: el
 * cobro llega por la notificación `Ds_Response` del comercio.
 *
 * Requisitos previos (no técnicos): ser comercio Redsys y tener Bizum
 * habilitado en el contrato. Sin eso, el TPV rechaza la operación.
 */

export const REDSYS_URLS = {
  test: "https://sis-t.redsys.es:25443/sis/realizarPago",
  live: "https://sis.redsys.es/sis/realizarPago",
} as const;

export type RedsysEnvironment = keyof typeof REDSYS_URLS;

export type BizumOrderInput = {
  merchantCode: string;
  terminal: number;
  order: string;
  amountCents: number;
  currency?: string;
  merchantUrl?: string | null;
  urlOk?: string | null;
  urlKo?: string | null;
  description?: string | null;
  titular?: string | null;
};

export const BIZUM_PAYMETHOD = "z";

/** Deriva la clave de firma: 3DES-CBC de la clave del comercio con IV de ceros. */
export function deriveMerchantKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  const iv = Buffer.alloc(8, 0);
  const cipher = crypto.createCipheriv("des-ede3-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.alloc(8, 0)), cipher.final()]);
}

/** Firma de Redsys v2: HMAC-SHA256 sobre los parámetros, en base64. */
export function signRedsysParameters(paramsBase64: string, base64Key: string): string {
  const hmac = crypto.createHmac("sha256", deriveMerchantKey(base64Key));
  hmac.update(paramsBase64);
  return hmac.digest("base64");
}

export function verifyRedsysSignature(paramsBase64: string, signature: string, base64Key: string): boolean {
  const expected = signRedsysParameters(paramsBase64, base64Key);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Número de pedido que exige Redsys: 4 a 12 caracteres, sin símbolos raros. */
export function redsysOrderNumber(publicCode: string, salt = ""): string {
  const clean = `${publicCode}${salt}`.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return clean.slice(-12).padStart(4, "0");
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export type BizumForm = { url: string; fields: { Ds_SignatureVersion: string; Ds_MerchantParameters: string; Ds_Signature: string } };

/** Construye el formulario de redirección al TPV con Bizum activado. */
export function buildBizumPaymentForm(
  input: BizumOrderInput & { secretKey: string; environment?: RedsysEnvironment },
): BizumForm {
  const currency = input.currency || "978";
  const parameters: Record<string, unknown> = {
    DS_MERCHANT_AMOUNT: String(Math.round(input.amountCents)),
    DS_MERCHANT_ORDER: input.order,
    DS_MERCHANT_MERCHANTCODE: input.merchantCode,
    DS_MERCHANT_CURRENCY: currency,
    DS_MERCHANT_TRANSACTIONTYPE: "0",
    DS_MERCHANT_TERMINAL: String(input.terminal),
    DS_MERCHANT_PAYMETHODS: BIZUM_PAYMETHOD,
  };
  if (input.merchantUrl) parameters.DS_MERCHANT_MERCHANTURL = input.merchantUrl;
  if (input.urlOk) parameters.DS_MERCHANT_URLOK = input.urlOk;
  if (input.urlKo) parameters.DS_MERCHANT_URLKO = input.urlKo;
  if (input.description) parameters.DS_MERCHANT_PRODUCTDESCRIPTION = String(input.description).slice(0, 125);
  if (input.titular) parameters.DS_MERCHANT_TITULAR = String(input.titular).slice(0, 60);

  const encoded = b64(parameters);
  return {
    url: REDSYS_URLS[input.environment || "live"],
    fields: {
      Ds_SignatureVersion: "HMAC_SHA256_V1",
      Ds_MerchantParameters: encoded,
      Ds_Signature: signRedsysParameters(encoded, input.secretKey),
    },
  };
}

/** Lee la respuesta del TPV: 0000–0099 son autorizadas. */
export function redsysResponseAuthorized(code: unknown): boolean {
  const value = String(code ?? "");
  if (!/^\d{1,4}$/.test(value)) return false;
  return Number(value) < 100;
}

export function parseRedsysNotification(body: { Ds_MerchantParameters?: string; Ds_Signature?: string }, secretKey: string) {
  const encoded = String(body?.Ds_MerchantParameters || "");
  if (!encoded) return { ok: false as const, reason: "MISSING_PARAMETERS" };
  if (!verifyRedsysSignature(encoded, String(body?.Ds_Signature || ""), secretKey)) {
    return { ok: false as const, reason: "INVALID_SIGNATURE" };
  }
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, string>;
  return {
    ok: true as const,
    order: decoded.Ds_Order || decoded.DS_MERCHANT_ORDER || null,
    responseCode: decoded.Ds_Response || null,
    authorized: redsysResponseAuthorized(decoded.Ds_Response),
    amountCents: Number(decoded.Ds_Amount || 0),
    method: decoded.Ds_Card_Brand || decoded.Ds_PayMethod || null,
  };
}

export function redsysBizumConfigured(env = process.env): boolean {
  return Boolean(env.REDSYS_MERCHANT_CODE && env.REDSYS_SECRET_KEY && env.REDSYS_TERMINAL);
}
