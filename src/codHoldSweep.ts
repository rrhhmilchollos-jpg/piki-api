/**
 * Barrido automático de garantías de contra­rreembolso (`CodHold`).
 *
 * El problema que resuelve: una retención de tarjeta no se queda quieta. El
 * banco la suelta solo a los siete días y, cuando lo hace, el pedido se queda
 * sin ninguna garantía sin que nadie se entere. Si además el rider nunca pulsa
 * «cobrado en efectivo», esa retención vive para siempre en la contabilidad
 * como si fuese dinero comprometido... hasta que desaparece sin dejar rastro.
 *
 * El barrido cierra ese círculo con tres reglas, en este orden:
 *
 *  1. Conciliar con el pedido. Si el pedido ya está cobrado en efectivo o
 *     anulado, la retención se libera en el acto, sin esperar al plazo.
 *  2. Conciliar con Stripe. El estado real del `PaymentIntent` manda: si el
 *     banco ya la soltó, se marca `expired`; si se cobró por otra vía, se marca
 *     `captured`; solo si sigue viva se cancela de verdad.
 *  3. Respetar los plazos. Se libera con 12 h de margen sobre los 7 días, que es
 *     justo antes de que el emisor la suelte por su cuenta.
 *
 * Nada se captura automáticamente. Cobrar dinero sin que una persona lo haya
 * decidido es la clase de automatismo que acaba en reclamaciones; cuando el
 * barrido detecta un pedido entregado sin cobro, lo deja marcado para revisión.
 */
import mongoose from "mongoose";
import {
  CodHold,
  codHoldLiability,
  normalizeReference,
  type CodHoldLiability,
  type CodHoldStatus,
} from "./codHolds.js";
import { Order } from "./models.js";
import { mapOrdersByReference, type OrderSnapshot } from "./orderReferences.js";
import {
  COD_RELEASE_MARGIN_MS,
  isAlreadyResolvedStripeError,
  releaseCodOrder,
  retrieveAuthorization,
  stripeConfigured,
  type AuthorizationSnapshot,
} from "./stripePayments.js";

/** Tiempo que una instancia reserva una retención para no pisarse con otra. */
export const COD_HOLD_CLAIM_MS = 2 * 60_000;
/** Retenciones que se revisan en cada pasada. */
export const DEFAULT_COD_HOLD_SWEEP_BATCH = 100;
/**
 * Antelación con la que se libera una garantía huérfana (sin pedido visible).
 * A 0 viene desactivado: liberar antes de plazo una garantía que quizá sostiene
 * una entrega en curso es peor que esperar al vencimiento.
 */
export const DEFAULT_COD_ORPHAN_RELEASE_HOURS = 0;
/** Margen para que una tarjeta a medio confirmar (3DS) se considere muerta. */
export const COD_HOLD_WAITING_CONFIRMATION_HOURS = 24;
/**
 * Antigüedad a partir de la cual una retención entra en el barrido aunque le
 * quede plazo. Sin esto, una garantía de un pedido ya cobrado en efectivo no se
 * miraría hasta el día 6, y la contabilidad la arrastraría como si fuese deuda.
 */
export const DEFAULT_COD_RECONCILE_AFTER_HOURS = 6;

export type CodHoldSweepAction = "release" | "review" | "skip";

export type CodHoldSweepReason =
  | "retencion_a_punto_de_caducar"
  | "retencion_vencida"
  | "pedido_cobrado_en_efectivo"
  | "pedido_reembolsado"
  | "pedido_anulado"
  | "referencia_huerfana"
  | "entregado_sin_cobro"
  | "caducada_en_banco"
  | "cobrada_en_stripe"
  | "tarjeta_no_confirmada"
  | "sin_stripe"
  | "stripe_en_proceso"
  | "espera_turno"
  | "ya_resuelta";

export interface CodHoldCandidate {
  reference: string;
  amountCents: number;
  paymentIntentId: string;
  status: CodHoldStatus;
  expiresAt: Date;
  createdAt: Date;
}

export interface CodHoldDecision {
  reference: string;
  paymentIntentId: string;
  amountCents: number;
  status: CodHoldStatus;
  action: CodHoldSweepAction;
  reason: CodHoldSweepReason;
  detail: string;
  expiresAt: string;
  ageHours: number;
  orderId: string | null;
  orphan: boolean;
}

export interface PlanCodHoldSweepInput {
  now: Date;
  holds: CodHoldCandidate[];
  /** Pedidos locales visibles, indexados por referencia normalizada. */
  orders: Map<string, OrderSnapshot>;
  releaseMarginMs?: number;
  orphanReleaseHours?: number;
  waitingConfirmationHours?: number;
}

function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round(((to.getTime() - from.getTime()) / 36e5) * 10) / 10);
}

/**
 * Decide qué hacer con cada retención. Es una función pura: sin base de datos,
 * sin Stripe y sin relojes escondidos, para poder fijar las reglas con pruebas.
 */
export function planCodHoldSweep(input: PlanCodHoldSweepInput): CodHoldDecision[] {
  const {
    now,
    holds,
    orders,
    releaseMarginMs = COD_RELEASE_MARGIN_MS,
    orphanReleaseHours = DEFAULT_COD_ORPHAN_RELEASE_HOURS,
    waitingConfirmationHours = COD_HOLD_WAITING_CONFIRMATION_HOURS,
  } = input;

  return holds.map((hold) => {
    const expiresAt = new Date(hold.expiresAt);
    const createdAt = new Date(hold.createdAt);
    const ageHours = hoursBetween(createdAt, now);
    const order = orders.get(normalizeReference(hold.reference)) ?? null;
    const shouldRelease = now.getTime() >= expiresAt.getTime() - releaseMarginMs;
    const overdue = now.getTime() >= expiresAt.getTime();

    const base = {
      reference: hold.reference,
      paymentIntentId: hold.paymentIntentId,
      amountCents: hold.amountCents,
      status: hold.status,
      expiresAt: expiresAt.toISOString(),
      ageHours,
      orderId: order?.orderId ?? null,
      orphan: !order,
    };

    const decide = (
      action: CodHoldSweepAction,
      reason: CodHoldSweepReason,
      detail: string,
    ): CodHoldDecision => ({ ...base, action, reason, detail });

    if (hold.status !== "authorized") {
      return decide("skip", "ya_resuelta", `la retención ya está en estado ${hold.status}`);
    }

    // 1) El pedido manda cuando está a la vista.
    if (order) {
      const paidInCash = Boolean(order.cashCollectedAt) || order.paymentState === "paid";
      if (paidInCash) {
        return decide(
          "release",
          "pedido_cobrado_en_efectivo",
          `el pedido ${order.reference} consta cobrado; la garantía no debe seguir retenida`,
        );
      }
      if (order.paymentState === "refunded") {
        return decide("release", "pedido_reembolsado", `el pedido ${order.reference} se reembolsó`);
      }
      if (order.status === "cancelled" || order.cancelledAt) {
        return decide("release", "pedido_anulado", `el pedido ${order.reference} está cancelado`);
      }
      if (order.paymentState === "expired" || order.paymentState === "failed") {
        return decide(
          "release",
          "pedido_anulado",
          `el pedido ${order.reference} figura con el pago ${order.paymentState}`,
        );
      }
      // Entregado sin cobro: hay motivo para capturar, pero eso lo decide una
      // persona. Marcamos la garantía para revisión y, si el plazo se agota, se
      // libera dejando el motivo escrito.
      if (order.deliveredAt && !shouldRelease) {
        return decide(
          "review",
          "entregado_sin_cobro",
          `el pedido ${order.reference} se entregó sin cobro; capturar a mano está a un clic`,
        );
      }
      if (order.deliveredAt && shouldRelease) {
        return decide(
          "release",
          "entregado_sin_cobro",
          `el pedido ${order.reference} se entregó sin cobro y la garantía ha llegado a su plazo`,
        );
      }
    }

    // 2) Plazos de la autorización.
    if (shouldRelease) {
      return overdue
        ? decide(
            "release",
            "retencion_vencida",
            `vencida hace ${hoursBetween(expiresAt, now)} h; se concilia con el estado real del banco`,
          )
        : decide(
            "release",
            "retencion_a_punto_de_caducar",
            `caduca en ${hoursBetween(now, expiresAt)} h; se libera con margen de seguridad`,
          );
    }

    // 3) Garantías huérfanas: la referencia no tiene pedido local. Solo se
    // adelantan si operaciones lo pide expresamente.
    if (!order && orphanReleaseHours > 0 && ageHours >= orphanReleaseHours) {
      return decide(
        "release",
        "referencia_huerfana",
        `sin pedido visible tras ${ageHours} h y con ${hoursBetween(now, expiresAt)} h de plazo restante`,
      );
    }

    // El resto sigue esperando: o no ha llegado su hora, o se confirmó la
    // tarjeta hace poco y está a medio resolver en el banco.
    if (ageHours < waitingConfirmationHours && !order) {
      return decide(
        "skip",
        "espera_turno",
        `retención de ${ageHours} h pendiente de confirmación y con plazo hasta ${expiresAt.toISOString()}`,
      );
    }
    return decide(
      "skip",
      "espera_turno",
      `quedan ${hoursBetween(now, expiresAt)} h de plazo y no hay motivo para resolverla aún`,
    );
  });
}

export interface CodHoldSweepTally {
  inspected: number;
  released: number;
  expired: number;
  captured: number;
  failed: number;
  skipped: number;
  needsReview: number;
  orphans: number;
  releasedCents: number;
}

/** Cuenta lo que el plan va a hacer. Se usa para el informe y las pruebas. */
export function tallyCodHoldDecisions(decisions: CodHoldDecision[]): CodHoldSweepTally {
  const tally: CodHoldSweepTally = {
    inspected: decisions.length,
    released: 0,
    expired: 0,
    captured: 0,
    failed: 0,
    skipped: 0,
    needsReview: 0,
    orphans: 0,
    releasedCents: 0,
  };
  for (const decision of decisions) {
    if (decision.orphan) tally.orphans += 1;
    if (decision.action === "review") tally.needsReview += 1;
    else if (decision.action === "skip") tally.skipped += 1;
    else if (decision.action === "release") {
      tally.released += 1;
      tally.releasedCents += decision.amountCents;
    }
  }
  return tally;
}

export type CodHoldSweepSource = "manual" | "worker";

export interface CodHoldSweepReport {
  dryRun: boolean;
  source: CodHoldSweepSource;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inspected: number;
  released: number;
  expired: number;
  captured: number;
  failed: number;
  skipped: number;
  needsReview: number;
  orphans: number;
  releasedCents: number;
  errors: string[];
  decisions: CodHoldDecision[];
  liability: CodHoldLiability;
}

export interface CodHoldStripeAdapter {
  configured: boolean;
  retrieve(paymentIntentId: string): Promise<AuthorizationSnapshot>;
  release(paymentIntentId: string, reason: string): Promise<{ status: string }>;
}

/** Adaptador real. En pruebas se inyecta uno falso y no se toca la red. */
export function defaultCodHoldStripeAdapter(): CodHoldStripeAdapter {
  return {
    configured: stripeConfigured(),
    retrieve: retrieveAuthorization,
    release: releaseCodOrder,
  };
}

const sweepRunSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ["manual", "worker"], default: "manual" },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    dryRun: { type: Boolean, default: true },
    inspected: { type: Number, default: 0 },
    released: { type: Number, default: 0 },
    expired: { type: Number, default: 0 },
    captured: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    needsReview: { type: Number, default: 0 },
    orphans: { type: Number, default: 0 },
    releasedCents: { type: Number, default: 0 },
    // `errors` es una ruta reservada de Mongoose (errores de validación).
    errorList: { type: [String], default: [] },
    decisions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "cod_hold_sweep_runs" },
);
sweepRunSchema.index({ createdAt: -1 });

export const CodHoldSweepRun =
  mongoose.models.CodHoldSweepRun || mongoose.model("CodHoldSweepRun", sweepRunSchema);

async function recordRun(report: CodHoldSweepReport, actorId?: string | null) {
  await CodHoldSweepRun.create({
    source: report.source,
    actorId: actorId && mongoose.isValidObjectId(actorId) ? new mongoose.Types.ObjectId(actorId) : null,
    dryRun: report.dryRun,
    inspected: report.inspected,
    released: report.released,
    expired: report.expired,
    captured: report.captured,
    failed: report.failed,
    skipped: report.skipped,
    needsReview: report.needsReview,
    orphans: report.orphans,
    releasedCents: report.releasedCents,
    errorList: report.errors,
    decisions: report.decisions.slice(0, 200),
    startedAt: new Date(report.startedAt),
    finishedAt: new Date(report.finishedAt),
    durationMs: report.durationMs,
  }).catch((error) =>
    console.warn("No se pudo registrar el barrido de garantías", error instanceof Error ? error.message : String(error)),
  );
}

/** Reserva atómica: solo una instancia puede resolver una retención a la vez. */
async function claimHold(reference: string, now: Date) {
  return CodHold.findOneAndUpdate(
    {
      reference,
      status: "authorized",
      $or: [{ sweepClaimedUntil: null }, { sweepClaimedUntil: { $lte: now } }],
    },
    {
      $set: { sweepClaimedUntil: new Date(now.getTime() + COD_HOLD_CLAIM_MS), lastSweepAt: now },
      $inc: { sweepAttempts: 1 },
    },
    { new: true },
  );
}

async function releaseClaim(reference: string) {
  await CodHold.updateOne({ reference, status: "authorized" }, { $set: { sweepClaimedUntil: null } }).catch(() => undefined);
}

async function resolveHold(
  reference: string,
  status: Exclude<CodHoldStatus, "authorized">,
  reason: string,
  now: Date,
  extra: { capturedCents?: number | null; stripeStatus?: string | null } = {},
) {
  return CodHold.findOneAndUpdate(
    { reference, status: "authorized" },
    {
      $set: {
        status,
        reason,
        resolvedAt: now,
        sweepClaimedUntil: null,
        lastSweepAt: now,
        lastSweepReason: reason,
        capturedCents: extra.capturedCents ?? null,
        stripeStatus: extra.stripeStatus ?? null,
      },
    },
    { new: true },
  );
}

/**
 * Deja el pedido local en el estado que le corresponde tras conciliar la
 * garantía. Nunca rebaja un pedido ya cobrado.
 */
async function reconcileOrder(
  orderId: string,
  reason: string,
  now: Date,
  capturedCents?: number | null,
) {
  if (!mongoose.isValidObjectId(orderId)) return;
  try {
    const order = await Order.findById(orderId).select("paymentState cashCollectedAt").lean();
    if (!order) return;
    const doc = order as unknown as { paymentState?: string; cashCollectedAt?: Date | null };
    const paidInCash = Boolean(doc.cashCollectedAt) || doc.paymentState === "paid";
    const patch: Record<string, unknown> = { paymentReleasedAt: now, paymentReleaseReason: reason };
    if (typeof capturedCents === "number" && capturedCents > 0) {
      patch.paymentState = "paid";
      patch.paymentCapturedAt = now;
      patch.paymentCapturedCents = capturedCents;
    } else if (paidInCash) {
      patch.paymentState = "paid";
    } else if (doc.paymentState === "pending" || doc.paymentState === "authorized") {
      patch.paymentState = "expired";
    }
    const filter: Record<string, unknown> = { _id: orderId };
    if (!paidInCash && !(typeof capturedCents === "number" && capturedCents > 0)) {
      filter.paymentState = { $ne: "paid" };
    }
    await Order.updateOne(filter, { $set: patch }).exec();
  } catch (error) {
    console.warn(
      "No se pudo conciliar el pedido con su garantía",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Suelta la garantía en cuanto el rider cobra en efectivo.
 *
 * El barrido periódico también lo haría, pero tardaría hasta la siguiente
 * pasada y el cliente vería el importe retenido en su banco después de haber
 * pagado. Se ejecuta en segundo plano para no retrasar la confirmación de la
 * entrega; si falla, el barrido lo recoge más tarde.
 */
export async function releaseCodHoldAfterCashPayment(
  input: { orderId?: string | null; reference?: string | null; stripePaymentIntentId?: string | null },
): Promise<{ released: boolean; reason: string }> {
  const adapter = defaultCodHoldStripeAdapter();
  if (!adapter.configured) return { released: false, reason: "sin_stripe" };
  const filters: Record<string, unknown>[] = [];
  if (input.orderId && mongoose.isValidObjectId(input.orderId)) filters.push({ orderId: new mongoose.Types.ObjectId(input.orderId) });
  if (input.reference) filters.push({ reference: normalizeReference(input.reference) });
  if (!filters.length) return { released: false, reason: "sin_referencia" };

  const hold = await CodHold.findOne({ status: "authorized", $or: filters })
    .sort({ createdAt: -1 })
    .lean()
    .exec() as Record<string, any> | null;
  const paymentIntentId = String(hold?.paymentIntentId ?? input.stripePaymentIntentId ?? "");
  if (!paymentIntentId) return { released: false, reason: "sin_retencion" };
  if (hold && !(await claimHold(String(hold.reference), new Date()))) return { released: false, reason: "ocupada" };

  try {
    const snapshot = await adapter.retrieve(paymentIntentId);
    if (snapshot.status === "canceled") {
      if (hold) await resolveHold(String(hold.reference), "expired", "caducada_en_banco", new Date(), { stripeStatus: snapshot.status });
      return { released: false, reason: "ya_caducada" };
    }
    if (snapshot.status !== "requires_capture") {
      if (hold) await releaseClaim(String(hold.reference));
      return { released: false, reason: `estado_${snapshot.status}` };
    }
    await adapter.release(paymentIntentId, "paid_in_cash");
    if (hold) await resolveHold(String(hold.reference), "released", "pedido_cobrado_en_efectivo", new Date(), { stripeStatus: "canceled" });
    return { released: true, reason: "liberada" };
  } catch (error) {
    if (hold) await releaseClaim(String(hold.reference));
    return { released: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface RunCodHoldSweepOptions {
  apply: boolean;
  source?: CodHoldSweepSource;
  actorId?: string | null;
  now?: Date;
  batchSize?: number;
  orphanReleaseHours?: number;
  reconcileAfterHours?: number;
  stripe?: CodHoldStripeAdapter;
}

/**
 * Una pasada del barrido. Sin `apply` solo planifica y no escribe nada, que es
 * lo que se usa para revisar antes de tocar producción.
 */
export async function runCodHoldSweep(options: RunCodHoldSweepOptions): Promise<CodHoldSweepReport> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const apply = options.apply === true;
  const source = options.source ?? "manual";
  const batchSize = Math.max(1, Math.min(500, options.batchSize ?? DEFAULT_COD_HOLD_SWEEP_BATCH));
  const orphanReleaseHours = Math.max(0, options.orphanReleaseHours ?? numberFromEnv("PIKI_COD_ORPHAN_RELEASE_HOURS", DEFAULT_COD_ORPHAN_RELEASE_HOURS));
  const reconcileAfterHours = Math.max(0, options.reconcileAfterHours ?? numberFromEnv("PIKI_COD_RECONCILE_AFTER_HOURS", DEFAULT_COD_RECONCILE_AFTER_HOURS));
  const adapter = options.stripe ?? defaultCodHoldStripeAdapter();

  // Dos motivos para mirar una retención: que se le acabe el plazo, o que ya
  // tenga edad suficiente para cruzarla con el pedido y con Stripe.
  const cutoff = new Date(now.getTime() + COD_RELEASE_MARGIN_MS);
  const clauses: Record<string, unknown>[] = [
    { expiresAt: { $lte: cutoff } },
    { createdAt: { $lte: new Date(now.getTime() - reconcileAfterHours * 36e5) } },
  ];
  const rows = (await CodHold.find({ status: "authorized", $or: clauses })
    .sort({ expiresAt: 1 })
    .limit(batchSize)
    .lean()
    .exec()) as Record<string, any>[];

  const candidates: CodHoldCandidate[] = rows.map((row) => ({
    reference: String(row.reference),
    amountCents: Number(row.amountCents ?? 0),
    paymentIntentId: String(row.paymentIntentId ?? ""),
    status: String(row.status) as CodHoldStatus,
    expiresAt: new Date(row.expiresAt),
    createdAt: new Date(row.createdAt ?? now),
  }));

  const orders = await mapOrdersByReference(candidates.map((candidate) => candidate.reference));
  const decisions = planCodHoldSweep({ now, holds: candidates, orders, orphanReleaseHours });
  const errors: string[] = [];
  let released = 0;
  let expired = 0;
  let captured = 0;
  let failedStatus = 0;
  let skipped = 0;
  let releasedCents = 0;

  for (const decision of decisions) {
    if (decision.action === "skip") {
      skipped += 1;
      continue;
    }
    // En seco se cuenta lo que se haría, igual que en el barrido de jornada:
    // así el informe sirve para decidir antes de tocar producción.
    if (!apply) {
      if (decision.action === "release") {
        released += 1;
        releasedCents += decision.amountCents;
      }
      continue;
    }
    if (decision.action === "review") {
      // Se deja constancia sin tocar el dinero: la revisión es humana.
      await CodHold.updateOne(
        { reference: decision.reference, status: "authorized" },
        { $set: { lastSweepAt: now, lastSweepReason: decision.reason } },
      ).catch(() => undefined);
      continue;
    }

    const claimed = await claimHold(decision.reference, now);
    if (!claimed) {
      skipped += 1;
      continue;
    }

    if (!adapter.configured) {
      await releaseClaim(decision.reference);
      skipped += 1;
      errors.push(`${decision.reference}: Stripe no configurada, no se puede conciliar`);
      continue;
    }

    try {
      const snapshot = await adapter.retrieve(decision.paymentIntentId);

      if (snapshot.status === "canceled") {
        // El banco ya la soltó: no hay nada que cancelar, solo cuadrar el registro.
        const resolved = await resolveHold(decision.reference, "expired", "caducada_en_banco", now, {
          stripeStatus: snapshot.status,
        });
        if (!resolved) {
          skipped += 1;
          continue;
        }
        expired += 1;
        if (decision.orderId) await reconcileOrder(decision.orderId, "garantia_caducada", now);
        continue;
      }

      if (snapshot.status === "succeeded") {
        const resolved = await resolveHold(decision.reference, "captured", "cobrada_en_stripe", now, {
          capturedCents: snapshot.capturedCents,
          stripeStatus: snapshot.status,
        });
        if (!resolved) {
          skipped += 1;
          continue;
        }
        captured += 1;
        if (decision.orderId) await reconcileOrder(decision.orderId, "cobrada_en_stripe", now, snapshot.capturedCents);
        continue;
      }

      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(snapshot.status)) {
        if (decision.ageHours < COD_HOLD_WAITING_CONFIRMATION_HOURS) {
          await releaseClaim(decision.reference);
          skipped += 1;
          continue;
        }
        const resolved = await resolveHold(decision.reference, "failed", "tarjeta_no_confirmada", now, {
          stripeStatus: snapshot.status,
        });
        if (!resolved) {
          skipped += 1;
          continue;
        }
        failedStatus += 1;
        continue;
      }

      if (snapshot.status !== "requires_capture") {
        // `processing` u otros estados transitorios: se reintenta en la próxima.
        await releaseClaim(decision.reference);
        skipped += 1;
        continue;
      }

      await adapter.release(decision.paymentIntentId, decision.reason);
      const resolved = await resolveHold(decision.reference, "released", decision.reason, now, {
        stripeStatus: "canceled",
      });
      if (!resolved) {
        // Otra instancia cerró el registro mientras hablábamos con Stripe: la
        // retención ya está liberada igualmente, así que no se cuenta dos veces.
        skipped += 1;
        continue;
      }
      released += 1;
      releasedCents += decision.amountCents;
      if (decision.orderId) await reconcileOrder(decision.orderId, decision.reason, now);
    } catch (error) {
      if (isAlreadyResolvedStripeError(error)) {
        const resolved = await resolveHold(decision.reference, "expired", "caducada_en_banco", now, {
          stripeStatus: "canceled",
        });
        if (!resolved) {
          skipped += 1;
          continue;
        }
        expired += 1;
        if (decision.orderId) await reconcileOrder(decision.orderId, "garantia_caducada", now);
        continue;
      }
      await releaseClaim(decision.reference);
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${decision.reference}: ${message}`);
    }
  }

  const finishedAt = new Date();
  const report: CodHoldSweepReport = {
    dryRun: !apply,
    source,
    startedAt,
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - now.getTime(),
    inspected: candidates.length,
    released,
    expired,
    captured,
    failed: failedStatus,
    skipped,
    needsReview: decisions.filter((decision) => decision.action === "review").length,
    orphans: decisions.filter((decision) => decision.orphan).length,
    releasedCents,
    errors,
    decisions,
    liability: await codHoldLiability(now),
  };

  await recordRun(report, options.actorId ?? null);
  return report;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

export interface CodHoldSweepRunSummary {
  id: string;
  source: string;
  dryRun: boolean;
  inspected: number;
  released: number;
  expired: number;
  captured: number;
  failed: number;
  skipped: number;
  needsReview: number;
  orphans: number;
  releasedCents: number;
  errors: string[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}

/** Historial de pasadas, para que operaciones pueda auditar qué pasó y cuándo. */
export async function listCodHoldSweepRuns(limit = 10): Promise<CodHoldSweepRunSummary[]> {
  const rows = (await CodHoldSweepRun.find({})
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(100, limit)))
    .lean()
    .exec()) as Record<string, any>[];
  return rows.map((row) => ({
    id: String(row._id),
    source: String(row.source ?? "manual"),
    dryRun: Boolean(row.dryRun),
    inspected: Number(row.inspected ?? 0),
    released: Number(row.released ?? 0),
    expired: Number(row.expired ?? 0),
    captured: Number(row.captured ?? 0),
    failed: Number(row.failed ?? 0),
    skipped: Number(row.skipped ?? 0),
    needsReview: Number(row.needsReview ?? 0),
    orphans: Number(row.orphans ?? 0),
    releasedCents: Number(row.releasedCents ?? 0),
    errors: Array.isArray(row.errorList) ? row.errorList.map((item: unknown) => String(item)) : [],
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  }));
}

/** Retenciones vivas con su antigüedad, para la pantalla de contabilidad. */
export async function listOpenCodHolds(limit = 50): Promise<
  Array<{
    reference: string;
    amountCents: number;
    status: CodHoldStatus;
    paymentIntentId: string;
    expiresAt: string;
    ageHours: number;
    hoursToExpiry: number;
    orderId: string | null;
    sweepAttempts: number;
    lastSweepAt: string | null;
    lastSweepReason: string | null;
    stripeStatus: string | null;
  }>
> {
  const now = new Date();
  const rows = (await CodHold.find({ status: "authorized" })
    .sort({ expiresAt: 1 })
    .limit(Math.max(1, Math.min(200, limit)))
    .lean()
    .exec()) as Record<string, any>[];
  return rows.map((row) => {
    const expiresAt = new Date(row.expiresAt);
    const createdAt = new Date(row.createdAt ?? now);
    return {
      reference: String(row.reference),
      amountCents: Number(row.amountCents ?? 0),
      status: String(row.status) as CodHoldStatus,
      paymentIntentId: String(row.paymentIntentId ?? ""),
      expiresAt: expiresAt.toISOString(),
      ageHours: hoursBetween(createdAt, now),
      hoursToExpiry: Math.round(((expiresAt.getTime() - now.getTime()) / 36e5) * 10) / 10,
      orderId: row.orderId ? String(row.orderId) : null,
      sweepAttempts: Number(row.sweepAttempts ?? 0),
      lastSweepAt: row.lastSweepAt ? new Date(row.lastSweepAt).toISOString() : null,
      lastSweepReason: row.lastSweepReason ?? null,
      stripeStatus: row.stripeStatus ?? null,
    };
  });
}
