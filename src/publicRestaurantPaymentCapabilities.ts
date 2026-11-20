import { allowedPaymentMethods, isRiderPurchase, type FulfillmentModel, type FulfillmentRestaurant, type PaymentMethod } from "./fulfillment.js";
import { cashCardGuaranteeRequiredForRestaurant } from "./cashCardGuaranteePolicy.js";
import { isCashPaymentEnabledForRestaurant } from "./paymentPolicy.js";

/** Public capabilities only; catalogue and quote use the same existing policy. */
export function publicRestaurantPaymentCapabilities(restaurant: FulfillmentRestaurant | null | undefined): {
  allowedPaymentMethods: PaymentMethod[];
  paymentMethods: PaymentMethod[];
  bizumOnly: boolean;
  fulfillmentModel: FulfillmentModel;
  cashPaymentsEnabled: boolean;
  cashCardGuaranteeRequired: boolean;
} {
  const methods = allowedPaymentMethods(restaurant);
  return {
    allowedPaymentMethods: [...methods],
    // Compatibility alias, never the unfiltered persisted configuration.
    paymentMethods: [...methods],
    bizumOnly: restaurant?.bizumOnly === true,
    fulfillmentModel: isRiderPurchase(restaurant) ? "rider_purchase" : "partner_managed",
    cashPaymentsEnabled: isCashPaymentEnabledForRestaurant(restaurant ?? {}),
    cashCardGuaranteeRequired: cashCardGuaranteeRequiredForRestaurant(restaurant),
  };
}
