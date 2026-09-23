import { rankDispatchCandidates } from "../src/dispatch.js";
import { calculateSettlement } from "../src/settlements.js";

const now = new Date("2026-09-23T10:00:00.000Z");
const restaurant = { name: "Brasa Callejera", location: [-0.5213, 38.9922] as [number, number] };
const customer = { address: "Carrer de Montcada, Xàtiva", location: [-0.5184, 38.9902] as [number, number] };
const order = { publicCode: "PIKI-DEMO-XATIVA-001", status: "paid", partner: restaurant.name, totalCents: 1949 };

console.log("01 CUSTOMER", JSON.stringify({ action: "pago confirmado en Stripe test", order }));
console.log("02 PARTNER", JSON.stringify({ action: "pedido recibido", status: "pending" }));
console.log("03 PARTNER", JSON.stringify({ action: "aceptar pedido", actorRole: "partner", status: "accepted", preparationMinutes: 15 }));
console.log("04 PARTNER", JSON.stringify({ action: "pasar a preparación", status: "preparing" }));

const candidates = [
  { id: "rider-near", status: "available" as const, vehicle: "scooter" as const, location: { coordinates: [-0.522, 38.9925] }, lastLocationAt: new Date(now.getTime() - 20_000), reliabilityScore: 0.94, activeOrderCount: 0, zoneFit: 1, servicePriority: 0.8 },
  { id: "rider-far", status: "available" as const, vehicle: "bike" as const, location: { coordinates: [-0.535, 38.998] }, lastLocationAt: new Date(now.getTime() - 30_000), reliabilityScore: 0.82, activeOrderCount: 1, zoneFit: 0.8, servicePriority: 0.5 },
];
const ranked = rankDispatchCandidates(candidates, { restaurantLocation: restaurant.location, customerLocation: customer.location, preparationMinutes: 15, now });
const winner = ranked[0];
if (!winner) throw new Error("NO_ELIGIBLE_RIDER");
console.log("05 FLEET", JSON.stringify({ action: "dispatch automático", selectedRider: winner.riderId, score: winner.score, reasons: winner.reasons }));
console.log("06 RIDER", JSON.stringify({ action: "oferta recibida", riderId: winner.riderId, expiresInSeconds: 60 }));
console.log("07 RIDER", JSON.stringify({ action: "aceptar oferta", status: "assigned" }));
console.log("08 PARTNER", JSON.stringify({ action: "pedido listo", status: "ready_for_pickup" }));
console.log("09 RIDER", JSON.stringify({ action: "confirmar recogida", status: "picked_up" }));
console.log("10 RIDER", JSON.stringify({ action: "confirmar entrega con PIN", status: "delivered" }));

const settlement = calculateSettlement([{ publicCode: order.publicCode, subtotalCents: 1590, deliveryFeeCents: 149, serviceFeeCents: 79, distanceKm: 1.7, tipCents: 0 }]);
console.log("11 FINANCE", JSON.stringify({ action: "liquidación calculada", settlement: settlement.lines[0], formulaVersion: settlement.formulaVersion }));
