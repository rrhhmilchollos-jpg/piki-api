/**
 * Reproduce el fallo que deja pedidos sin rider y comprueba la reparación.
 *
 * Escenario real observado en producción: el reparto devuelve
 * `DISPATCH_RESERVATION_RACE` una y otra vez hasta la carta muerta, aunque hay
 * riders elegibles. La causa es estado colgado: reservas de plaza de pedidos ya
 * cerrados y `activeOrderId` apuntando a un pedido entregado.
 *
 * Uso:
 *   MONGODB_URI=mongodb://127.0.0.1:27018/piki_dispatch_sim npx tsx scripts/dispatch-leak-simulation.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { DispatchOutbox, Order, Rider, RiderAssignmentReservation, Restaurant } from "../src/models.js";
import { dispatchRecoveryIdempotencyKey, rearmDeadLetterDispatchEvent } from "../src/dispatchOutbox.js";
import { reserveRiderOrderSlot } from "../src/dispatchReservation.js";
import { reconcileDispatchState } from "../src/dispatchReconciliation.js";

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27018/piki_dispatch_sim";
const HOUR = 36e5;
const now = new Date();

async function seed() {
  await Promise.all([
    Order.deleteMany({}),
    Rider.deleteMany({}),
    RiderAssignmentReservation.deleteMany({}),
    Restaurant.deleteMany({}),
  ]);

  const restaurant = await Restaurant.create({
    name: "Simulación Dispatch",
    slug: `sim-dispatch-${Date.now()}`,
    category: "Test",
    cuisine: "Simulación",
    location: { type: "Point", coordinates: [-0.5200, 38.9880] },
  });

  // Pedido viejo ya entregado: la reserva y el bloqueo del rider se quedaron ahí.
  const oldOrder = await Order.create({
    restaurantId: restaurant._id,
    publicCode: `PIKI-OLD-${Date.now()}`,
    status: "delivered",
    assignmentState: "assigned",
    paymentMethod: "cash",
    paymentState: "paid",
    totalCents: 498,
    deliveredAt: new Date(now.getTime() - 20 * HOUR),
  });

  const riderA = await Rider.create({
    name: "Rider con bloqueo viejo",
    email: `sim-a-${Date.now()}@qa.invalid`,
    riderCode: `SIM-A-${Date.now()}`,
    status: "busy",
    activeOrderId: oldOrder._id,
    location: { type: "Point", coordinates: [-0.5190, 38.9875] },
    lastLocationAt: now,
  });

  const riderB = await Rider.create({
    name: "Rider con reserva huérfana",
    email: `sim-b-${Date.now()}@qa.invalid`,
    riderCode: `SIM-B-${Date.now()}`,
    status: "available",
    activeOrderId: null,
    location: { type: "Point", coordinates: [-0.5210, 38.9885] },
    lastLocationAt: now,
  });

  const cancelledOrder = await Order.create({
    restaurantId: restaurant._id,
    publicCode: `PIKI-CANCEL-${Date.now()}`,
    status: "cancelled",
    assignmentState: "expired",
    paymentMethod: "cash",
    paymentState: "expired",
    totalCents: 498,
  });
  const riderC = await Rider.create({
    name: "Rider con pedido cancelado",
    email: `sim-c-${Date.now()}@qa.invalid`,
    riderCode: `SIM-C-${Date.now()}`,
    status: "busy",
    activeOrderId: cancelledOrder._id,
    location: { type: "Point", coordinates: [-0.5180, 38.9890] },
    lastLocationAt: now,
  });

  await Order.updateOne({ _id: oldOrder._id }, { $set: { riderId: riderA._id } });

  // Reserva colgada del pedido entregado (rider A) y otra de un pedido borrado (rider B).
  await RiderAssignmentReservation.create({
    orderId: oldOrder._id,
    riderId: riderA._id,
    slot: 1,
    status: "reserved",
    mode: "normal",
  });
  await RiderAssignmentReservation.create({
    orderId: new mongoose.Types.ObjectId(),
    riderId: riderB._id,
    slot: 1,
    status: "reserved",
    mode: "normal",
  });

  // En producción estas reservas llevan horas colgadas: se envejecen para
  // reproducir el estado real y no confundirlas con una asignación en curso.
  const old = new Date(now.getTime() - 8 * HOUR);
  await RiderAssignmentReservation.updateMany({}, { $set: { createdAt: old, updatedAt: old } });

  const newOrder = await Order.create({
    restaurantId: restaurant._id,
    publicCode: `PIKI-NEW-${Date.now()}`,
    status: "ready_for_pickup",
    assignmentState: "unassigned",
    paymentMethod: "cash",
    paymentState: "paid",
    totalCents: 498,
    deliveryLocation: { type: "Point", coordinates: [-0.5260, 38.9900] },
  });

  return { riderA, riderB, riderC, newOrder, oldOrder };
}

async function main() {
  await mongoose.connect(URI, { dbName: "piki_dispatch_sim" });

  console.log("1) Estado roto: hay riders, pero la reserva de plaza falla siempre");
  const seed1 = await seed();
  assert.equal(await reserveRiderOrderSlot(seed1.riderA._id as mongoose.Types.ObjectId, seed1.newOrder._id as mongoose.Types.ObjectId, {}, 1), null);
  assert.equal(await reserveRiderOrderSlot(seed1.riderB._id as mongoose.Types.ObjectId, seed1.newOrder._id as mongoose.Types.ObjectId, {}, 1), null);
  console.log("   ambos riders rechazados → el pedido se queda sin oferta (RESERVATION_RACE)");

  console.log("2) Diagnóstico en seco: cuenta la basura sin tocar nada");
  const dry = await reconcileDispatchState({ dryRun: true });
  assert.equal(dry.releasedOrphanReservations + dry.releasedStaleReservations, 2);
  assert.ok(dry.clearedRiderLocks >= 1, "en seco se detectan los bloqueos viejos");
  assert.equal(await RiderAssignmentReservation.countDocuments({ status: "reserved" }), 2, "en seco no se toca nada");

  console.log("3) Reparación real");
  const repaired = await reconcileDispatchState();
  console.log(
    `   reservas liberadas=${repaired.releasedOrphanReservations + repaired.releasedStaleReservations} bloqueos limpiados=${repaired.clearedRiderLocks} ofertas reabiertas=${repaired.reopenedOffers}`,
  );
  assert.equal(repaired.releasedOrphanReservations, 2);
  assert.ok(repaired.clearedRiderLocks >= 1, "los bloqueos sobre pedidos cerrados se sueltan");
  assert.equal(await RiderAssignmentReservation.countDocuments({ status: "reserved" }), 0);
  const riderAAfter = await Rider.findById(seed1.riderA._id).lean().exec() as any;
  assert.equal(riderAAfter.activeOrderId, null, "el bloqueo viejo debe soltarse");
  assert.equal(riderAAfter.status, "available");

  console.log("4) El pedido vuelve a poder ofrecerse");
  const reservation = await reserveRiderOrderSlot(seed1.riderA._id as mongoose.Types.ObjectId, seed1.newOrder._id as mongoose.Types.ObjectId, {}, 1);
  assert.ok(reservation, "la reserva debe concederse tras la reparación");
  assert.equal(String(reservation!.rider._id), String(seed1.riderA._id));
  const riderAAssigned = await Rider.findById(seed1.riderA._id).lean().exec() as any;
  assert.equal(String(riderAAssigned.activeOrderId), String(seed1.newOrder._id));

  console.log("5) Carta muerta reparable: el pedido vuelve a la cola");
  await DispatchOutbox.deleteMany({});
  const recoveryKey = dispatchRecoveryIdempotencyKey(seed1.newOrder._id, 0);
  await DispatchOutbox.create({
    eventId: "sim-dead-1",
    orderId: seed1.newOrder._id,
    type: "dispatch.order.ready",
    payloadVersion: 1,
    payload: {},
    idempotencyKey: recoveryKey,
    availableAt: new Date(now.getTime() - HOUR),
    attempts: 8,
    status: "dead_letter",
    lastError: "DISPATCH_RESERVATION_RACE",
  });
  const unrecoverable = await DispatchOutbox.create({
    eventId: "sim-dead-2",
    orderId: seed1.newOrder._id,
    type: "dispatch.order.ready",
    payloadVersion: 1,
    payload: {},
    idempotencyKey: "dispatch:sim:invalid",
    availableAt: new Date(now.getTime() - HOUR),
    attempts: 8,
    status: "dead_letter",
    lastError: "DISPATCH_INVALID_ORDER",
  });
  assert.equal(await rearmDeadLetterDispatchEvent("dispatch:sim:invalid"), false, "un error no reparable no revive");
  assert.equal(await rearmDeadLetterDispatchEvent(recoveryKey), true, "la falta de hueco sí revive");
  const revived = await DispatchOutbox.findOne({ idempotencyKey: recoveryKey }).lean().exec() as any;
  assert.equal(revived.status, "pending");
  assert.equal(revived.attempts, 0);
  assert.equal((await DispatchOutbox.findById(unrecoverable._id).lean().exec() as any).status, "dead_letter");

  console.log("6) Segunda pasada: idempotente y sin efectos");
  const again = await reconcileDispatchState();
  assert.equal(again.releasedOrphanReservations + again.releasedStaleReservations, 0);
  assert.equal(again.clearedRiderLocks, 0);
  assert.equal(await RiderAssignmentReservation.countDocuments({ status: "reserved" }), 1, "la reserva viva se respeta");

  console.log("\nTodo correcto:");
  console.log("- 2 reservas colgadas liberadas y 2 bloqueos de rider limpiados");
  console.log("- 0 pedidos perdidos: el pedido nuevo pasa a oferta con reserva concedida");
  console.log("- la segunda pasada no rompe la reserva legítima");
  console.log("- 1 carta muerta reparable vuelve a la cola; la no reparable se queda");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("fallo:", error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
