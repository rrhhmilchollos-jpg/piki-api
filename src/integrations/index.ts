/**
 * Punto único de integraciones externas y adaptadores entre superficies.
 * Las rutas HTTP de server.ts importan desde aquí para evitar clientes duplicados.
 */
export {
  createCheckoutSession,
  processStripeWebhook,
  stripeConfigured,
} from "../stripe.js";
export {
  createSignaturitSignature,
  signaturitBaseUrl,
  signaturitConfigured,
  signaturitMode,
  signatureWebhookUrl,
  webhookDigest,
} from "../signaturit.js";
export { handleCustomerTrpc, currentCustomer } from "../customerCompat.js";
