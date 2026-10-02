# Reserva atómica de fondos para turnos garantizados

Este patrón reserva el **máximo complemento posible** al guardar/confirmar un turno elegible. Con 7 €/h y cuatro horas, el máximo es `2.800` céntimos por turno. La reserva no es un pago ni un movimiento bancario; es un compromiso dentro del tope mensual global.

> El código es TypeScript para Mongoose/Express. Debe conectarse a MongoDB en replica set o clúster compatible con transacciones. La garantía debe permanecer desactivada hasta configurar un tope, probar las transacciones y publicar las condiciones del piloto.

## 1. Esquemas

Añadir el saldo reservado al presupuesto actual y crear un documento idempotente por slot:

```ts
// En RiderIncentiveBudget:
reservedCents: { type: Number, required: true, min: 0, default: 0 },

const riderShiftGuaranteeReservationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  slotId: { type: Schema.Types.ObjectId, ref: "RiderSlot", required: true, unique: true },
  monthKey: { type: String, required: true, index: true }, // YYYY-MM local del turno
  amountCents: { type: Number, required: true, min: 1 },
  payoutCents: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ["reserved", "released", "settled"], default: "reserved", index: true },
}, { timestamps: true, collection: "rider_shift_guarantee_reservations" });

riderShiftGuaranteeReservationSchema.index({ slotId: 1 }, { unique: true });
export const RiderShiftGuaranteeReservation = mongoose.models.RiderShiftGuaranteeReservation
  || mongoose.model("RiderShiftGuaranteeReservation", riderShiftGuaranteeReservationSchema);
```

`RiderIncentiveBudget` debe conservar el índice único `(tenantId, monthKey)`. Para el cap global, el registro usa `tenantId: null`, igual que el libro de incentivos global.

## 2. Reserva condicional dentro de una transacción

La comparación `committedCents + reservedCents <= capCents` se ejecuta en el propio filtro de Mongo. La escritura condicional evita que dos peticiones simultáneas reserven el último saldo disponible.

```ts
import mongoose from "mongoose";
import { RiderIncentiveBudget, RiderShiftGuaranteeReservation } from "./models.js";

const globalBudget = { tenantId: null };
const capCents = () => Math.max(0, Math.floor(Number(process.env.PIKI_RIDER_INCENTIVES_MONTHLY_CAP_CENTS || 0)));
const guaranteeOn = () => process.env.PIKI_HOURLY_GUARANTEE_ENABLED === "true";
const reserveCents = 7_00 * 4; // 7 €/h × 4 h = 28 €

function eligibleForGuaranteedSlot(slot: any) {
  const start = Number(slot.startTime?.slice(0, 2)) * 60 + Number(slot.startTime?.slice(3, 5));
  const end = Number(slot.endTime?.slice(0, 2)) * 60 + Number(slot.endTime?.slice(3, 5));
  return guaranteeOn()
    && slot.status === "planned"
    && slot.zoneSlug === (process.env.PIKI_HOURLY_GUARANTEE_ZONE_SLUG || "xativa-centro")
    && end - start === 4 * 60;
}

export async function reserveGuaranteedShiftFunds(slot: any, session: mongoose.ClientSession) {
  if (!eligibleForGuaranteedSlot(slot)) return true; // no es un turno con garantía
  const cap = capCents();
  if (cap < reserveCents) return false;
  const monthKey = String(slot.date).slice(0, 7); // la fecha del slot está en calendario local
  const existing = await RiderShiftGuaranteeReservation.findOne({ slotId: slot._id }).session(session).lean().exec() as any;
  if (existing?.status === "reserved") return true; // repetición idempotente
  if (existing?.status === "settled") return false; // un turno liquidado no se vuelve a reservar

  await RiderIncentiveBudget.updateOne(
    { ...globalBudget, monthKey },
    { $setOnInsert: { ...globalBudget, monthKey, capCents: cap, committedCents: 0, reservedCents: 0 } },
    { upsert: true, session },
  ).exec();

  const budget = await RiderIncentiveBudget.findOneAndUpdate(
    {
      ...globalBudget,
      monthKey,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$committedCents", 0] }, { $ifNull: ["$reservedCents", 0] }] },
          cap - reserveCents,
        ],
      },
    },
    { $inc: { reservedCents: reserveCents }, $set: { capCents: cap } },
    { new: true, session },
  ).lean().exec();
  if (!budget) return false; // cap agotado: la ruta debe abortar la transacción

  const values = {
    riderId: slot.riderId,
    monthKey,
    amountCents: reserveCents,
    payoutCents: 0,
    status: "reserved",
    tenantId: slot.tenantId || null,
  };
  if (existing) {
    await RiderShiftGuaranteeReservation.updateOne({ _id: existing._id, status: "released" }, { $set: values }, { session }).exec();
  } else {
    await RiderShiftGuaranteeReservation.create([{ ...values, slotId: slot._id }], { session });
  }
  return true;
}
```

## 3. Confirmar el slot y reservar juntos

No confirmes primero y reserves después: un fallo en la segunda operación dejaría un turno prometido sin cobertura presupuestaria. La creación/actualización del slot y la reserva se confirman o se revierten conjuntamente.

```ts
app.post("/api/v1/rider-slots", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = riderSlotCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_SLOT" });

  const session = await mongoose.startSession();
  let slot: any;
  try {
    await session.withTransaction(async () => {
      slot = await RiderSlot.findOneAndUpdate(
        { riderId: parsed.data.riderId, ...tenantScope(req), date: parsed.data.date, startTime: parsed.data.startTime },
        { $set: { ...parsed.data, ...tenantScope(req), status: "planned" } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      ).lean().exec();

      const reserved = await reserveGuaranteedShiftFunds(slot, session);
      if (!reserved) {
        const error = new Error("GUARANTEE_BUDGET_EXHAUSTED");
        (error as any).code = "GUARANTEE_BUDGET_EXHAUSTED";
        throw error; // aborta también el upsert del slot
      }
    });
    return res.status(201).json({ slot, guaranteeReserved: eligibleForGuaranteedSlot(slot) });
  } catch (error: any) {
    if (error?.code === "GUARANTEE_BUDGET_EXHAUSTED") {
      return res.status(409).json({ error: "GUARANTEE_BUDGET_EXHAUSTED", message: "Se alcanzó el límite mensual disponible; este turno no puede confirmarse con garantía." });
    }
    // Un índice único de slot/reserva protege las peticiones concurrentes.
    if (error?.code === 11000) return res.status(409).json({ error: "RIDER_SLOT_ALREADY_EXISTS" });
    throw error;
  } finally {
    await session.endSession();
  }
});
```

En producción, reutiliza la validación actual del rider, flota, tenant y zona antes de escribir. Repite la llamada a `reserveGuaranteedShiftFunds` en el endpoint semanal dentro de **la misma** transacción para sus siete slots; si uno supera el cap, se revierte la semana completa.

## 4. Liberar o liquidar el hold

Al cancelar/no presentarse, cambia `reserved → released` y reduce `reservedCents` en la misma transacción. Al cerrar un turno elegible, convierte el hold máximo en el complemento real: si el rider ya ganó 18 € en pedidos frente a un suelo de 28 €, se mantienen 10 € como `committedCents` y se liberan 18 €.

```ts
export async function settleGuaranteedShiftFunds(slotId: mongoose.Types.ObjectId, payoutCents: number, session: mongoose.ClientSession) {
  const hold = await RiderShiftGuaranteeReservation.findOne({ slotId, status: "reserved" }).session(session).lean().exec() as any;
  if (!hold) return false;
  if (!Number.isInteger(payoutCents) || payoutCents < 0 || payoutCents > hold.amountCents) throw new Error("INVALID_GUARANTEE_PAYOUT");

  const budgetChange = await RiderIncentiveBudget.updateOne(
    { ...globalBudget, monthKey: hold.monthKey, reservedCents: { $gte: hold.amountCents } },
    { $inc: { reservedCents: -hold.amountCents, committedCents: payoutCents } },
    { session },
  ).exec();
  if (budgetChange.modifiedCount !== 1) throw new Error("GUARANTEE_BUDGET_INVARIANT_BROKEN");
  await RiderShiftGuaranteeReservation.updateOne(
    { _id: hold._id, status: "reserved" },
    { $set: { status: "settled", payoutCents } },
    { session },
  ).exec();
  return true;
}
```

Si el turno no cumple asistencia/aceptación/zona, llama la misma transición con `payoutCents = 0` (o a una función equivalente de liberación), para devolver todo el hold. La escritura de la entrada de libro `hourly_guarantee` debe incluirse en esa transacción cuando `payoutCents > 0`, con una `sourceKey` única como `hourly-guarantee:<slotId>:policy-1`.

## Controles antes de activar

- Todos los bonos pagados también deben comprobar `committedCents + reservedCents` al reservar presupuesto; si no, los referidos podrían consumir fondos ya bloqueados para turnos.
- `committedCents` representa incentivos devengados; `reservedCents` representa obligaciones posibles. El disponible es `max(0, capCents - committedCents - reservedCents)`.
- Liberar reservas de turnos cancelados/no presentados y aplicar idempotencia por `slotId`.
- En el panel, mostrar presupuesto disponible y responder `409 GUARANTEE_BUDGET_EXHAUSTED` antes de confirmar un turno sin cobertura.
- No se crea una reserva para slots no elegibles ni para riders de prueba; excluir test orders del cálculo de pedidos y de la tasa de aceptación.
