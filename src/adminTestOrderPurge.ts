import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ClientSession } from "mongoose";
import mongoose from "mongoose";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { requireOwner } from "./auth.js";
import { CashLedgerEntry, DispatchDecision, DispatchOutbox, Notification, Order, Rider, RiderAssignmentReservation, RiderOrderMessage, Restaurant, StripeEvent, SupportTicket, TestOrderPurgeAudit, TestOrderPurgePreview } from "./models.js";
import { RiderIncentiveEntry } from "./riderIncentivesModels.js";
import { buildPurgeConfirmationPhrase, getStaticPurgeBlockReasons, getTestOrderMarkers, isKnownQaSupportTicket, SAFE_ISOLATED_QA_ORDER_STATUSES, SAFE_TEST_ORDER_PAYMENT_STATES, TEST_ORDER_PURGE_MAX_CANDIDATES, TEST_ORDER_PURGE_SCOPE, TEST_ORDER_PURGE_SCOPE_VERSION, TEST_ORDER_PURGE_TTL_MS } from "./testOrderPurgePolicy.js";

type RateLimitFactory = (limit: number, windowMs: number, keyPrefix: string) => RequestHandler;

class PurgeError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

type PurgeCandidate = {
  id: mongoose.Types.ObjectId;
  publicCode: string;
  restaurantId: mongoose.Types.ObjectId;
  restaurantName: string | null;
  qaRiderId: mongoose.Types.ObjectId | null;
  status: string;
  paymentState: string;
  paymentMethod: string;
  totalCents: number;
  createdAt: Date | null;
  markers: string[];
  isolatedQaSimulation: boolean;
  eligible: boolean;
  blockReasons: string[];
  qaSupportTicketIds: mongoose.Types.ObjectId[];
};

type PurgeSnapshot = {
  candidates: PurgeCandidate[];
  qaRestaurantMatches: Array<{ id: string; name: string }>;
  hash: string;
};

const previewRequestSchema = z.object({ scope: z.literal(TEST_ORDER_PURGE_SCOPE) }).strict();
const executeRequestSchema = z.object({
  previewId: z.string().regex(/^[a-f\d]{24}$/i),
  previewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expectedDeleteCount: z.number().int().min(1).max(TEST_ORDER_PURGE_MAX_CANDIDATES),
  confirmationPhrase: z.string().min(1).max(100),
}).strict();

const exactQaRestaurantPattern = /^\s*KFC\s+XATIVA\s+QA\s*$/i;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const asString = (value: unknown) => value === null || value === undefined ? "" : String(value);
const uniqueIds = (values: unknown[]) => [...new Map(values.filter(Boolean).map((value) => [String(value), value as mongoose.Types.ObjectId])).values()];
const attachSession = (query: any, session?: ClientSession) => session ? query.session(session) : query;

function candidateFilter(qaRestaurantIds: mongoose.Types.ObjectId[]) {
  const clauses: Record<string, unknown>[] = [
    { isTestOrder: true },
    { qaRiderId: { $exists: true, $ne: null } },
  ];
  if (qaRestaurantIds.length) clauses.push({ restaurantId: { $in: qaRestaurantIds } });
  return { $or: clauses };
}

function hashSnapshot(candidates: PurgeCandidate[], qaRestaurantMatches: Array<{ id: string; name: string }>) {
  const canonical = {
    scopeVersion: TEST_ORDER_PURGE_SCOPE_VERSION,
    qaRestaurantMatches: [...qaRestaurantMatches].sort((a, b) => a.id.localeCompare(b.id)),
    candidates: [...candidates].sort((a, b) => String(a.id).localeCompare(String(b.id))).map((candidate) => ({
      id: String(candidate.id),
      publicCode: candidate.publicCode,
      restaurantId: String(candidate.restaurantId),
      restaurantName: candidate.restaurantName,
      qaRiderId: candidate.qaRiderId ? String(candidate.qaRiderId) : null,
      status: candidate.status,
      paymentState: candidate.paymentState,
      paymentMethod: candidate.paymentMethod,
      totalCents: candidate.totalCents,
      createdAt: candidate.createdAt?.toISOString() || null,
      markers: [...candidate.markers].sort(),
      isolatedQaSimulation: candidate.isolatedQaSimulation,
      eligible: candidate.eligible,
      blockReasons: [...candidate.blockReasons].sort(),
      qaSupportTicketIds: candidate.qaSupportTicketIds.map(String).sort(),
    })),
  };
  return sha256(JSON.stringify(canonical));
}

async function buildPurgeSnapshot(session?: ClientSession): Promise<PurgeSnapshot> {
  let qaRestaurantQuery = Restaurant.find({ name: exactQaRestaurantPattern }).select("_id name").lean();
  const qaRestaurants = await attachSession(qaRestaurantQuery, session).exec() as any[];
  if (qaRestaurants.length > 1) throw new PurgeError(409, "QA_RESTAURANT_NAME_AMBIGUOUS", { matchingRestaurantCount: qaRestaurants.length });
  const qaRestaurantIds = qaRestaurants.map((restaurant) => restaurant._id as mongoose.Types.ObjectId);
  const qaRestaurantIdsSet = new Set(qaRestaurantIds.map(String));
  const qaRestaurantMatches = qaRestaurants.map((restaurant) => ({ id: String(restaurant._id), name: String(restaurant.name || "") }));

  const projection = "_id publicCode restaurantId qaRiderId riderId isTestOrder status paymentState paymentMethod cashCollectedAt cashCollectedByRiderId stripeCheckoutSessionId stripePaymentIntentId assignmentState totalCents createdAt";
  const orderQuery = Order.find(candidateFilter(qaRestaurantIds)).select(projection).sort({ _id: 1 }).limit(TEST_ORDER_PURGE_MAX_CANDIDATES + 1).lean();
  const orders = await attachSession(orderQuery, session).exec() as any[];
  if (orders.length > TEST_ORDER_PURGE_MAX_CANDIDATES) throw new PurgeError(413, "TOO_MANY_TEST_ORDER_CANDIDATES", { maximum: TEST_ORDER_PURGE_MAX_CANDIDATES, candidateCountAtLeast: orders.length });

  if (!orders.length) return { candidates: [], qaRestaurantMatches, hash: hashSnapshot([], qaRestaurantMatches) };

  const orderIds = orders.map((order) => order._id as mongoose.Types.ObjectId);
  const publicCodes = orders.map((order) => String(order.publicCode || "")).filter(Boolean);
  const qaRiderIds = uniqueIds(orders.map((order) => order.qaRiderId));
  const restaurantIds = uniqueIds(orders.map((order) => order.restaurantId));
  const idStrings = orderIds.map(String);

  const restaurantQuery = Restaurant.find({ _id: { $in: restaurantIds } }).select("_id name").lean();
  const restaurants = await attachSession(restaurantQuery, session).exec() as any[];
  const restaurantNames = new Map(restaurants.map((restaurant) => [String(restaurant._id), String(restaurant.name || "")]));

  const qaRiderQuery = Rider.find({ _id: { $in: qaRiderIds }, isTestRider: true }).select("_id isTestRider").lean();
  const qaRiders = await attachSession(qaRiderQuery, session).exec() as any[];
  const qaRiderSet = new Set(qaRiders.map((rider) => String(rider._id)));

  const ticketQuery = SupportTicket.find({ $or: [{ orderId: { $in: orderIds } }, { orderReference: { $in: publicCodes } }] }).select("_id orderId orderReference sourceRole ticketNumber").lean();
  const tickets = await attachSession(ticketQuery, session).exec() as any[];
  const codeToId = new Map(orders.map((order) => [String(order.publicCode || ""), String(order._id)]));
  const candidateIdSet = new Set(idStrings);
  const ticketsByOrder = new Map<string, any[]>();
  for (const ticket of tickets) {
    const linkedOrderIds = new Set<string>();
    const orderId = ticket.orderId ? String(ticket.orderId) : "";
    const referenceOrderId = codeToId.get(String(ticket.orderReference || "")) || "";
    if (candidateIdSet.has(orderId)) linkedOrderIds.add(orderId);
    if (referenceOrderId) linkedOrderIds.add(referenceOrderId);
    const conflictingReferences = linkedOrderIds.size > 1;
    for (const orderKey of linkedOrderIds) {
      const list = ticketsByOrder.get(orderKey) || [];
      list.push({ ...ticket, conflictingReferences });
      ticketsByOrder.set(orderKey, list);
    }
  }

  const cashQuery = CashLedgerEntry.find({ orderId: { $in: orderIds } }).select("orderId").lean();
  const cashEntries = await attachSession(cashQuery, session).exec() as any[];
  const cashOrderIds = new Set(cashEntries.map((entry) => String(entry.orderId)));

  const stripeQuery = StripeEvent.find({ orderCode: { $in: publicCodes } }).select("orderCode").lean();
  const stripeEvents = await attachSession(stripeQuery, session).exec() as any[];
  const stripeOrderCodes = new Set(stripeEvents.map((event) => String(event.orderCode || "")));

  const activeRiderQuery = Rider.find({ activeOrderId: { $in: orderIds } }).select("_id isTestRider activeOrderId").lean();
  const activeRiderReferences = await attachSession(activeRiderQuery, session).exec() as any[];
  const activeRidersByOrder = new Map<string, any[]>();
  for (const rider of activeRiderReferences) {
    const key = String(rider.activeOrderId);
    const list = activeRidersByOrder.get(key) || [];
    list.push(rider);
    activeRidersByOrder.set(key, list);
  }

  const incentiveQuery = RiderIncentiveEntry.find({ $or: [
    { "metadata.orderId": { $in: [...orderIds, ...idStrings] } },
    { "metadata.orderCode": { $in: publicCodes } },
    { "metadata.publicCode": { $in: publicCodes } },
  ] }).select("metadata").lean();
  const incentiveEntries = await attachSession(incentiveQuery, session).exec() as any[];
  const incentiveLinkedIds = new Set<string>();
  for (const entry of incentiveEntries) {
    const metadata = entry.metadata || {};
    const linked = asString(metadata.orderId);
    if (idStrings.includes(linked)) incentiveLinkedIds.add(linked);
    const code = asString(metadata.orderCode || metadata.publicCode);
    const matching = orders.find((order) => String(order.publicCode || "") === code);
    if (matching) incentiveLinkedIds.add(String(matching._id));
  }

  const candidates: PurgeCandidate[] = orders.map((order) => {
    const id = String(order._id);
    const qaRiderId = order.qaRiderId ? String(order.qaRiderId) : "";
    const isolatedQaSimulation = order.isTestOrder === true
      && Boolean(qaRiderId)
      && qaRiderSet.has(qaRiderId)
      && (!order.riderId || String(order.riderId) === qaRiderId);
    const blockReasons = getStaticPurgeBlockReasons(order, isolatedQaSimulation);
    const orderTickets = ticketsByOrder.get(id) || [];
    const qaTickets = isolatedQaSimulation ? orderTickets.filter(isKnownQaSupportTicket) : [];
    if (orderTickets.length && qaTickets.length !== orderTickets.length) blockReasons.push("SUPPORT_TICKET_REFERENCE");
    if (orderTickets.some((ticket) => ticket.conflictingReferences)) blockReasons.push("SUPPORT_TICKET_REFERENCE_CONFLICT");
    if (cashOrderIds.has(id)) blockReasons.push("CASH_LEDGER_REFERENCE");
    if (stripeOrderCodes.has(String(order.publicCode || ""))) blockReasons.push("STRIPE_EVENT_REFERENCE");
    if (incentiveLinkedIds.has(id)) blockReasons.push("RIDER_INCENTIVE_REFERENCE");
    const activeRiders = activeRidersByOrder.get(id) || [];
    const hasOnlyQaActiveReference = isolatedQaSimulation && activeRiders.length > 0 && activeRiders.every((rider) => rider.isTestRider === true && String(rider._id) === qaRiderId);
    if (activeRiders.length && !hasOnlyQaActiveReference) blockReasons.push("ACTIVE_RIDER_REFERENCE");

    return {
      id: order._id as mongoose.Types.ObjectId,
      publicCode: String(order.publicCode || ""),
      restaurantId: order.restaurantId as mongoose.Types.ObjectId,
      restaurantName: restaurantNames.get(String(order.restaurantId)) || null,
      qaRiderId: order.qaRiderId || null,
      status: String(order.status || "unknown"),
      paymentState: String(order.paymentState || "unknown"),
      paymentMethod: String(order.paymentMethod || "unknown"),
      totalCents: Number(order.totalCents || 0),
      createdAt: order.createdAt ? new Date(order.createdAt) : null,
      markers: getTestOrderMarkers(order, qaRestaurantIdsSet),
      isolatedQaSimulation,
      eligible: false,
      blockReasons: [...new Set(blockReasons)].sort(),
      qaSupportTicketIds: qaTickets.map((ticket) => ticket._id as mongoose.Types.ObjectId),
    };
  }).map((candidate) => ({ ...candidate, eligible: candidate.blockReasons.length === 0 }));

  return { candidates, qaRestaurantMatches, hash: hashSnapshot(candidates, qaRestaurantMatches) };
}

function safeTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(expectedHash || "", "hex");
  return actual.length === expected.length && actual.length > 0 && timingSafeEqual(actual, expected);
}

function publicPreview(snapshot: PurgeSnapshot) {
  const eligibleCount = snapshot.candidates.filter((candidate) => candidate.eligible).length;
  return {
    scope: TEST_ORDER_PURGE_SCOPE,
    scopeVersion: TEST_ORDER_PURGE_SCOPE_VERSION,
    qaRestaurantMatches: snapshot.qaRestaurantMatches,
    counts: {
      candidates: snapshot.candidates.length,
      eligible: eligibleCount,
      blocked: snapshot.candidates.length - eligibleCount,
    },
    confirmationPhrase: eligibleCount ? buildPurgeConfirmationPhrase(eligibleCount) : null,
    candidates: snapshot.candidates.map((candidate) => ({
      id: String(candidate.id),
      publicCode: candidate.publicCode,
      restaurant: candidate.restaurantName,
      status: candidate.status,
      paymentState: candidate.paymentState,
      paymentMethod: candidate.paymentMethod,
      totalCents: candidate.totalCents,
      createdAt: candidate.createdAt?.toISOString() || null,
      markers: candidate.markers,
      isolatedQaSimulation: candidate.isolatedQaSimulation,
      disposition: candidate.eligible ? "eligible" : "blocked",
      blockReasons: candidate.blockReasons,
      qaSupportTicketsToRemove: candidate.qaSupportTicketIds.length,
    })),
  };
}

function isTransactionUnsupported(error: any): boolean {
  const message = String(error?.message || "");
  return error?.code === 20 || error?.codeName === "IllegalOperation" || /Transaction numbers are only allowed|replica set member or mongos|transactions are not supported/i.test(message);
}

function registerRoutes(app: Express, limiter: RateLimitFactory, ownerGuard: RequestHandler) {
  app.post("/api/v1/admin/maintenance/test-orders/preview", limiter(3, 60_000, "test-order-purge-preview"), ownerGuard, async (req, res) => {
    const parsed = previewRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_TEST_ORDER_PURGE_SCOPE", expectedScope: TEST_ORDER_PURGE_SCOPE });
    const actorEmployeeId = req.auth?.employeeId ? new mongoose.Types.ObjectId(req.auth.employeeId) : null;
    if (!actorEmployeeId) return res.status(403).json({ error: "SUPERADMIN_EMPLOYEE_SESSION_REQUIRED" });

    let snapshot: PurgeSnapshot;
    try {
      snapshot = await buildPurgeSnapshot();
    } catch (error: any) {
      if (error instanceof PurgeError) return res.status(error.status).json({ error: error.code, ...error.details });
      throw error;
    }
    const base = publicPreview(snapshot);
    const eligible = snapshot.candidates.filter((candidate) => candidate.eligible);
    if (!eligible.length) return res.json({ ...base, previewId: null, previewToken: null, expiresAt: null });

    const previewToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + TEST_ORDER_PURGE_TTL_MS);
    const preview = await TestOrderPurgePreview.create({
      actorEmployeeId,
      tokenHash: sha256(previewToken),
      snapshotHash: snapshot.hash,
      candidateOrderIds: snapshot.candidates.map((candidate) => candidate.id),
      eligibleOrderIds: eligible.map((candidate) => candidate.id),
      expectedDeleteCount: eligible.length,
      scopeVersion: TEST_ORDER_PURGE_SCOPE_VERSION,
      expiresAt,
    });
    return res.status(201).json({ ...base, previewId: String(preview._id), previewToken, expiresAt: expiresAt.toISOString() });
  });

  app.post("/api/v1/admin/maintenance/test-orders/delete", limiter(2, 60_000, "test-order-purge-delete"), ownerGuard, async (req, res) => {
    const parsed = executeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_TEST_ORDER_PURGE_CONFIRMATION", details: parsed.error.flatten() });
    const actorEmployeeId = req.auth?.employeeId ? new mongoose.Types.ObjectId(req.auth.employeeId) : null;
    if (!actorEmployeeId) return res.status(403).json({ error: "SUPERADMIN_EMPLOYEE_SESSION_REQUIRED" });
    const previewObjectId = new mongoose.Types.ObjectId(parsed.data.previewId);
    const session = await mongoose.startSession();
    let outcome: { auditId: string; deletedCount: number; deletedPublicCodes: string[]; removedQaSupportTickets: number } | null = null;
    try {
      await session.withTransaction(async () => {
        const previewQuery = TestOrderPurgePreview.findOne({ _id: previewObjectId, actorEmployeeId, consumedAt: null, expiresAt: { $gt: new Date() } }).select("+tokenHash");
        const preview = await attachSession(previewQuery, session).lean().exec() as any;
        if (!preview) throw new PurgeError(410, "PREVIEW_EXPIRED_USED_OR_NOT_OWNED");
        if (!safeTokenMatches(parsed.data.previewToken, String(preview.tokenHash || ""))) throw new PurgeError(403, "INVALID_PREVIEW_TOKEN");
        if (Number(preview.expectedDeleteCount) !== parsed.data.expectedDeleteCount || parsed.data.confirmationPhrase !== buildPurgeConfirmationPhrase(Number(preview.expectedDeleteCount))) {
          throw new PurgeError(400, "EXPLICIT_COUNT_CONFIRMATION_REQUIRED", { expectedDeleteCount: Number(preview.expectedDeleteCount), requiredPhrase: buildPurgeConfirmationPhrase(Number(preview.expectedDeleteCount)) });
        }
        if (Number(preview.scopeVersion) !== TEST_ORDER_PURGE_SCOPE_VERSION) throw new PurgeError(409, "PURGE_SCOPE_VERSION_CHANGED");

        const current = await buildPurgeSnapshot(session);
        if (current.hash !== preview.snapshotHash) throw new PurgeError(409, "PREVIEW_STALE_REVIEW_REQUIRED");
        const eligible = current.candidates.filter((candidate) => candidate.eligible);
        const eligibleIds = eligible.map((candidate) => candidate.id);
        const storedEligibleIds = (preview.eligibleOrderIds || []).map(String).sort();
        if (eligibleIds.map(String).sort().join(",") !== storedEligibleIds.join(",") || eligible.length !== parsed.data.expectedDeleteCount) {
          throw new PurgeError(409, "PREVIEW_STALE_REVIEW_REQUIRED");
        }

        const qaRestaurantIds = current.qaRestaurantMatches.map((restaurant) => new mongoose.Types.ObjectId(restaurant.id));
        const safeStatusFilter = {
          $or: [
            { status: "cancelled" },
            { isTestOrder: true, qaRiderId: { $exists: true, $ne: null }, status: { $in: [...SAFE_ISOLATED_QA_ORDER_STATUSES] } },
          ],
        };
        const deleteFilter = {
          _id: { $in: eligibleIds },
          $and: [
            candidateFilter(qaRestaurantIds),
            safeStatusFilter,
            { paymentState: { $in: [...SAFE_TEST_ORDER_PAYMENT_STATES] } },
            { $or: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionId: "" }] },
            { $or: [{ stripePaymentIntentId: null }, { stripePaymentIntentId: "" }] },
            { $or: [{ cashCollectedAt: null }, { cashCollectedAt: { $exists: false } }] },
            { $or: [{ cashCollectedByRiderId: null }, { cashCollectedByRiderId: { $exists: false } }] },
          ],
        };

        const ticketIds = uniqueIds(eligible.flatMap((candidate) => candidate.qaSupportTicketIds));
        let removedQaSupportTickets = 0;
        await DispatchOutbox.deleteMany({ orderId: { $in: eligibleIds } }, { session });
        await DispatchDecision.deleteMany({ orderId: { $in: eligibleIds } }, { session });
        await RiderAssignmentReservation.deleteMany({ orderId: { $in: eligibleIds } }, { session });
        await RiderOrderMessage.deleteMany({ orderId: { $in: eligibleIds } }, { session });
        if (ticketIds.length) {
          const ticketDeleteResult = await SupportTicket.deleteMany({ _id: { $in: ticketIds }, sourceRole: "qa", ticketNumber: /^SUP-QA-[A-Z0-9-]+$/i }, { session });
          removedQaSupportTickets = Number(ticketDeleteResult.deletedCount || 0);
          if (removedQaSupportTickets !== ticketIds.length) throw new PurgeError(409, "PURGE_PRECONDITION_CHANGED", { expectedQaSupportTicketCount: ticketIds.length, deletedQaSupportTicketCount: removedQaSupportTickets });
        }
        await Notification.deleteMany({ entityType: "order", entityId: { $in: [...eligibleIds.map(String), ...eligible.map((candidate) => candidate.publicCode)] } }, { session });
        await Rider.updateMany({ isTestRider: true, activeOrderId: { $in: eligibleIds } }, { $set: { activeOrderId: null, status: "offline" } }, { session });

        const deleteResult = await Order.deleteMany(deleteFilter, { session });
        if (Number(deleteResult.deletedCount || 0) !== eligible.length) throw new PurgeError(409, "PURGE_PRECONDITION_CHANGED", { expectedDeleteCount: eligible.length, deletedCount: Number(deleteResult.deletedCount || 0) });

        const deletedAt = new Date();
        const audits = await TestOrderPurgeAudit.create([{
          actorEmployeeId,
          previewId: preview._id,
          scopeVersion: TEST_ORDER_PURGE_SCOPE_VERSION,
          deletedOrderIds: eligibleIds,
          deletedPublicCodes: eligible.map((candidate) => candidate.publicCode),
          deletedCount: eligible.length,
          deletedAt,
        }], { session });
        const consumed = await TestOrderPurgePreview.updateOne({ _id: preview._id, consumedAt: null }, { $set: { consumedAt: deletedAt } }, { session }).exec();
        if (Number(consumed.modifiedCount || 0) !== 1) throw new PurgeError(409, "PREVIEW_ALREADY_CONSUMED");
        outcome = { auditId: String(audits[0]._id), deletedCount: eligible.length, deletedPublicCodes: eligible.map((candidate) => candidate.publicCode), removedQaSupportTickets };
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
    } catch (error: any) {
      if (error instanceof PurgeError) return res.status(error.status).json({ error: error.code, ...error.details });
      if (isTransactionUnsupported(error)) return res.status(503).json({ error: "MONGODB_TRANSACTION_REQUIRED", message: "La purga requiere MongoDB en replica set/mongos; no se ejecutó ningún borrado." });
      throw error;
    } finally {
      await session.endSession();
    }

    const completedOutcome = outcome as { auditId: string; deletedCount: number; deletedPublicCodes: string[]; removedQaSupportTickets: number } | null;
    if (!completedOutcome) return res.status(500).json({ error: "PURGE_DID_NOT_COMPLETE" });
    return res.json({
      deletedCount: completedOutcome.deletedCount,
      deletedPublicCodes: completedOutcome.deletedPublicCodes,
      removedQaSupportTickets: completedOutcome.removedQaSupportTickets,
      auditId: completedOutcome.auditId,
      preserved: { restaurants: true, employeeAccounts: true, customerAccounts: true, riderAccounts: true, cashLedger: true, stripeEvents: true },
    });
  });
}

export function registerAdminTestOrderPurgeRoutes(app: Express, rateLimit: RateLimitFactory) {
  registerRoutes(app, rateLimit, requireOwner());
}
