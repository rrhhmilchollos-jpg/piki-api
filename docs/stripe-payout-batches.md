# Lotes de liquidación y Stripe

Los endpoints actuales separan preparación, aprobación y registro del pago externo. La ruta `/pay` no crea una transferencia Stripe: recibe el identificador de una transferencia ya ejecutada y marca el lote como pagado. Esto evita declarar dinero enviado cuando no existe una confirmación bancaria.

## Partner

```ts
app.post("/api/v1/finance/payout-batches/:id/approve", requireRole("admin", "finance"), async (req, res) => {
  const id = objectId(String(req.params.id));
  if (!id) return res.status(400).json({ error: "INVALID_PAYOUT_BATCH_ID" });
  const batch = await PartnerPayoutBatch.findOneAndUpdate(
    { _id: id, ...tenantScope(req), status: "prepared" },
    { $set: { status: "approved" } },
    { new: true },
  ).lean().exec();
  if (!batch) return res.status(409).json({ error: "PAYOUT_BATCH_NOT_PREPARED" });
  return res.json({ approved: true, batch });
});

app.post("/api/v1/finance/payout-batches/:id/pay", requireRole("admin", "finance"), async (req, res) => {
  const id = objectId(String(req.params.id));
  const parsed = z.object({ externalTransferId: z.string().trim().min(3).max(180), note: z.string().trim().max(1000).optional() }).safeParse(req.body);
  if (!id || !parsed.success) return res.status(400).json({ error: "INVALID_PAYOUT_EXECUTION" });
  const batch = await markPartnerBatchPaid({
    batchId: id,
    externalTransferId: parsed.data.externalTransferId,
    actor: { employeeId: req.auth?.employeeId, role: req.auth?.role, tenantId: (req.auth as any)?.tenantId },
    note: parsed.data.note,
  });
  return res.json({ paid: true, batch });
});
```

## Rider

```ts
app.post("/api/v1/finance/rider-payouts/prepare", requireRole("admin", "finance"), async (req, res) => {
  const parsed = z.object({ riderId: z.string().regex(/^[a-f\d]{24}$/i), startsAt: z.coerce.date(), endsAt: z.coerce.date() }).refine((v) => v.endsAt > v.startsAt).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_PAYOUT_PERIOD" });
  const riderId = objectId(parsed.data.riderId);
  const orders = await Order.find({ ...tenantScope(req), riderId, status: "delivered", paymentState: "paid", deliveredAt: { $gte: parsed.data.startsAt, $lt: parsed.data.endsAt }, riderPayoutStatus: { $in: ["pending", "eligible"] }, riderPayoutBatchId: null }).select("_id riderEarningsCents").lean().exec();
  if (!orders.length) return res.status(409).json({ error: "NO_RIDER_PAYOUTS_ELIGIBLE" });
  const amountCents = orders.reduce((sum, order) => sum + Number(order.riderEarningsCents || 0), 0);
  const idempotencyKey = `rider:${riderId}:${parsed.data.startsAt.toISOString()}:${parsed.data.endsAt.toISOString()}`;
  const batch = await RiderPayoutBatch.findOneAndUpdate({ idempotencyKey }, { $setOnInsert: { tenantId: (req.auth as any)?.tenantId || null, riderId, orderIds: orders.map((order) => order._id), startsAt: parsed.data.startsAt, endsAt: parsed.data.endsAt, amountCents, idempotencyKey, status: "prepared", externalTransferId: null } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
  return res.status(201).json({ prepared: true, batch });
});

app.post("/api/v1/finance/rider-payouts/:id/pay", requireRole("admin", "finance"), async (req, res) => {
  const id = objectId(String(req.params.id));
  const parsed = z.object({ externalTransferId: z.string().trim().min(3).max(180), note: z.string().trim().max(1000).optional() }).safeParse(req.body);
  if (!id || !parsed.success) return res.status(400).json({ error: "INVALID_RIDER_PAYOUT_EXECUTION" });
  const batch = await markRiderBatchPaid({ batchId: id, externalTransferId: parsed.data.externalTransferId, actor: { employeeId: req.auth?.employeeId, role: req.auth?.role, tenantId: (req.auth as any)?.tenantId }, note: parsed.data.note });
  return res.json({ paid: true, batch });
});
```

Para automatizar la creación de una transferencia Stripe real todavía hay que completar la vinculación de cada beneficiario a una cuenta Connect verificada y añadir una acción de doble aprobación. No se debe llamar a `stripe.transfers.create` o `stripe.payouts.create` desde una acción automática sin ese control.
