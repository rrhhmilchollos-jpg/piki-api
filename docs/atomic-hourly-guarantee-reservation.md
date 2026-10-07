# Reserva atómica de fondos para turnos garantizados

## Qué cubre el control

La garantía configurada equivale a **7 €/hora × 4 horas = 28 € (2.800 céntimos) por turno elegible**. Al confirmar el turno se reserva el máximo complemento posible; **no es un pago ni un movimiento bancario**. El saldo reservado se contabiliza junto con los incentivos ya devengados para que bonos de captación y garantías compartan el mismo tope mensual global.

El programa solo admite nuevas reservas si `PIKI_HOURLY_GUARANTEE_ENABLED=true` y `PIKI_RIDER_INCENTIVES_MONTHLY_CAP_CENTS` es positivo. El bucket global usa `tenantId: null`; las reservas se agrupan por el mes calendario del turno (`YYYY-MM`, fecha local de Xàtiva).

## Persistencia

`RiderIncentiveBudget` guarda `capCents`, `committedCents` y `reservedCents`, con índice único `(tenantId, monthKey)`. `RiderShiftGuaranteeReservation` mantiene una fila idempotente por `slotId` (índice único), el rider, mes/horario/zona, importe reservado y estado `reserved | released | settled`.

El disponible se calcula así:

```ts
Math.max(0, capCents - committedCents - reservedCents)
```

El modelo y los índices se registran en `src/riderIncentivesModels.ts` y `src/models.ts`.

## Orden de escritura

1. `prepareGuaranteedShiftBudgets(slots)` crea, fuera de la transacción financiera, solo el bucket mensual vacío (`$setOnInsert`). Esto no reserva saldo. Reintenta colisiones del índice único que pueden ocurrir al preparar el primer turno del mes.
2. Dentro de `session.withTransaction`, el endpoint guarda el slot y llama a `reserveGuaranteedShiftFunds(slot, session)`.
3. El servicio ejecuta un `findOneAndUpdate` condicional sobre el bucket. El filtro Mongo exige que:

   ```text
   committedCents + reservedCents + 2.800 <= capCents configurado
   ```

   La actualización incrementa `reservedCents` en 2.800 y crea/actualiza el ledger por slot en **la misma transacción** que el horario. Si no hay margen, lanza `GUARANTEE_BUDGET_EXHAUSTED`; la transacción revierte el slot y la API devuelve HTTP 409 (`RIDER_INCENTIVE_BUDGET_EXHAUSTED`). Dos asignaciones simultáneas compiten por una actualización atómica del mismo documento global, por lo que no pueden reservar el mismo saldo disponible.

4. La misma operación cubre la asignación individual, la semana completa, la edición de un slot elegible y el inicio de un turno planificado al que le faltara la reserva. La asignación semanal guarda todos los días seleccionados como una unidad: si cualquiera excede el presupuesto, no se guarda ninguno.
5. Cancelar o cambiar el turno para que deje de ser elegible cambia `reserved → released` y resta exactamente el hold del bucket dentro de la misma transacción. Los turnos activos o completados no se pueden sobrescribir/cancelar desde Fleet.
6. Al finalizar, las condiciones de presencia, GPS central, aceptación y duración se evalúan. Si no se cumplen, se libera el hold. Si se cumplen, el backend cambia el hold a `settled`, resta 2.800 de `reservedCents` y suma únicamente el complemento ganado a `committedCents`; la entrada de cartera se crea con `sourceKey` idempotente en esa misma transacción. Por ejemplo, si la tarifa pagada por PIKI en entregas del turno suma 18 €, se comprometen 10 € y se liberan los otros 18 €.

## Núcleo del control atómico

El bucket debe existir antes de entrar en esta transacción. `prepareGuaranteedShiftBudgets` se encarga de crearlo sin mover fondos; no debe sustituirse por un upsert monetario separado del commit del slot.

```ts
const budget = await RiderIncentiveBudget.findOneAndUpdate(
  {
    tenantId: null,
    monthKey,
    $expr: {
      $lte: [
        { $add: [
          { $ifNull: ["$committedCents", 0] },
          { $ifNull: ["$reservedCents", 0] },
        ] },
        capCents - amountCents,
      ],
    },
  },
  { $inc: { reservedCents: amountCents }, $set: { capCents } },
  { new: true, session },
).lean().exec();

if (!budget) throw new Error("GUARANTEE_BUDGET_EXHAUSTED");

await RiderShiftGuaranteeReservation.findOneAndUpdate(
  { slotId: slot._id },
  { $set: {
    tenantId: slot.tenantId || null,
    riderId: slot.riderId,
    slotId: slot._id,
    monthKey,
    slotDate: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    zoneSlug: slot.zoneSlug,
    amountCents,
    guaranteedFloorCents: amountCents,
    payoutCents: 0,
    status: "reserved",
    reservedAt: new Date(),
    releasedAt: null,
    settledAt: null,
  } },
  { upsert: true, new: true, setDefaultsOnInsert: true, session },
).lean().exec();
```

El código ejecutable vive en `src/riderIncentives.ts`; las rutas transaccionales y el mapeo de errores están en `src/server.ts`. MongoDB debe admitir transacciones (replica set o clúster compatible).

## Controles operativos

- No activar el piloto hasta fijar el cap global, zona central, política pública y pruebas de transacciones en el entorno productivo.
- Reservar el máximo al confirmar reduce el riesgo de prometer turnos sin liquidez asignada, pero hace que las plazas futuras consuman presupuesto antes de pagarse.
- Los holds no deben liberarse al desactivar nuevas altas si hay un turno ya iniciado: el servicio sigue registrando ese turno y lo liquida/libera al completarse.
- Una bajada posterior del cap no revierte compromisos existentes; bloquea nuevas reservas/premios. No reducir el cap por debajo de obligaciones ya reservadas sin una decisión operativa explícita.
- Supervisar por mes `committedCents`, `reservedCents`, `capCents` y el recuento de reservas `reserved/released/settled`.
