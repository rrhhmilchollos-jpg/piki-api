import { createHash } from "node:crypto";
import type { ClientSession } from "mongoose";
import { z } from "zod";
import { CustomerAccount } from "./models.js";
import { customerMenuForRestaurant } from "./customerCatalogPolicy.js";
import { quoteMenuItem, usesReferenceAddOns } from "./menuModifiers.js";

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const customerQuoteExpectationSchema = z.object({
  subtotalCents: cents,
  deliveryFeeCents: cents,
  serviceFeeCents: cents,
  creditAppliedCents: cents,
  totalCents: cents,
  quoteToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CustomerQuoteExpectation = z.infer<typeof customerQuoteExpectationSchema>;
export class CustomerQuoteConflict extends Error {
  constructor() { super("QUOTE_CHANGED"); }
}

export function customerQuotedItems(restaurant: any, requested: unknown) {
  if (!Array.isArray(requested) || !requested.length) throw new Error("EMPTY_BASKET");
  const menu = customerMenuForRestaurant(restaurant);
  return requested.map((line: any) => {
    const item = menu.find((candidate: any) => candidate.id === line?.id);
    const quantity = Number(line?.quantity);
    if (!item || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("PRODUCT_UNAVAILABLE");
    const quote = quoteMenuItem(item, line.selections, usesReferenceAddOns(restaurant));
    return { itemId: item.id, name: quote.name, quantity, unitPriceCents: quote.unitPriceCents, selectedOptions: quote.selectedOptions };
  });
}

export function applicableCustomerCredit(wallet: any, maximumCents: number, now = new Date()): number {
  const balance = wallet?.pikiCreditsCents ?? 0;
  const expiry = wallet?.pikiCreditsExpiresAt ? new Date(wallet.pikiCreditsExpiresAt).getTime() : 0;
  if (!Number.isSafeInteger(balance) || balance < 0) throw new Error("INVALID_CREDIT_BALANCE");
  return expiry > now.getTime() ? Math.min(balance, maximumCents) : 0;
}

// A deterministic comparison token, NOT a payment authorization. Every amount,
// identity and snapshot is recomputed by the API; no client discount is trusted.
function stable(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
export function customerOrderQuote(input: {
  restaurant: any; customerId: string | null; wallet: any; items: ReturnType<typeof customerQuotedItems>;
  deliveryPoint: [number, number]; deliveryFeeCents: number; serviceFeeCents: number; paymentMethod: string;
}) {
  const subtotalCents = input.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const grossCents = subtotalCents + input.deliveryFeeCents + input.serviceFeeCents;
  if (![subtotalCents, grossCents].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("INVALID_TOTAL");
  const creditAppliedCents = input.paymentMethod === "stripe" ? applicableCustomerCredit(input.wallet, grossCents) : 0;
  const amounts = { subtotalCents, deliveryFeeCents: input.deliveryFeeCents, serviceFeeCents: input.serviceFeeCents, creditAppliedCents, totalCents: grossCents - creditAppliedCents };
  const row = input.restaurant;
  const state = {
    customerId: input.customerId, restaurantId: String(row._id), tenantId: String(row.tenantId || ""),
    menu: row.menu, menuRevision: row.menuRevision ?? 0, priceIncludesCommission: row.priceIncludesCommission,
    commissionRateBps: row.partnerProfile?.commissionRateBps, slug: row.slug,
    listingType: row.listingType, fulfillmentMode: row.fulfillmentMode, fulfillmentModel: row.fulfillmentModel,
    isActive: row.isActive, onboardingStatus: row.onboardingStatus, availabilityStatus: row.availabilityStatus,
    internalDemo: row.internalDemo, paymentMethods: row.paymentMethods, bizumOnly: row.bizumOnly,
    cashPaymentsEnabled: row.cashPaymentsEnabled,
    wallet: input.paymentMethod === "stripe" ? { balance: input.wallet?.pikiCreditsCents ?? null, expiresAt: input.wallet?.pikiCreditsExpiresAt ?? null } : null,
    items: input.items, deliveryPoint: input.deliveryPoint, paymentMethod: input.paymentMethod, amounts,
  };
  const expectation = { ...amounts, quoteToken: createHash("sha256").update(JSON.stringify(stable(state))).digest("hex") };
  return { ...amounts, needsAddress: false as const, expectation };
}
export function assertCustomerQuoteExpectation(expected: CustomerQuoteExpectation, actual: CustomerQuoteExpectation) {
  for (const key of Object.keys(actual) as Array<keyof CustomerQuoteExpectation>) {
    if (expected[key] !== actual[key]) throw new CustomerQuoteConflict();
  }
}

/** Serialize the exact wallet snapshot BEFORE Order.create, in the SAME transaction.
 * The DB clock also guards expiry at the conditional debit, not at an earlier read.
 * Zero-credit snapshots are conditional too: a concurrent top-up must not slip in.
 * There is no retry with a different/lesser discount; the transaction must abort.
 */
export async function debitQuotedCustomerCredits(customerId: string, wallet: any, applied: number, session: ClientSession) {
  const exact = (value: any) => value === undefined ? { $exists: false } : value;
  const filter: any = { _id: customerId, pikiCreditsCents: exact(wallet?.pikiCreditsCents), pikiCreditsExpiresAt: exact(wallet?.pikiCreditsExpiresAt) };
  if (applied > 0) filter.$expr = { $gt: ["$pikiCreditsExpiresAt", "$$NOW"] };
  else if (Number(wallet?.pikiCreditsCents || 0) > 0 && wallet?.pikiCreditsExpiresAt) filter.$expr = { $lte: ["$pikiCreditsExpiresAt", "$$NOW"] };
  // updatedAt provides a real write/serialization lock even for a zero debit.
  const result = await CustomerAccount.updateOne(filter, { $inc: { pikiCreditsCents: -applied }, $currentDate: { updatedAt: true } }, { session, timestamps: false }).exec();
  if (result.matchedCount !== 1) throw new CustomerQuoteConflict();
}
