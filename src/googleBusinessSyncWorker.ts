import { randomUUID } from "node:crypto";
import { publishCatalogUpdate } from "./catalogRealtime.js";
import { GoogleBusinessConnection } from "./expansionModels.js";
import { fromGoogleLocationHours, googleBusinessConfigured, readGoogleLocation } from "./googleBusinessProfile.js";
import { Restaurant } from "./models.js";
import { normalizeOpeningHours, type CanonicalOpeningHours, type OpeningInterval, type WeekdayKey, WEEKDAY_KEYS } from "./openingHours.js";

const DEFAULT_CADENCE_MINUTES = 15;
const MINIMUM_CADENCE_MINUTES = 5;
const LOCK_LEASE_MS = 4 * 60_000;
const MAX_BATCH_SIZE = 10;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

export type GoogleBusinessSyncSettings = {
  enabled: boolean;
  cadenceMinutes: number;
  cadenceMs: number;
};

type SyncConnection = {
  _id: unknown;
  restaurantId: unknown;
  googleLocationName?: string | null;
  syncFailureCount?: number;
};

type RestaurantHoursRow = {
  _id: unknown;
  partnerProfile?: { openingHours?: unknown };
};

type StableInterval = Pick<OpeningInterval, "open" | "close"> & { endsNextDay: boolean };
type StableOverride = { date: string; endDate?: string; closed: boolean; intervals: StableInterval[] };
type StableHours = {
  timeZone: string;
  regular: Partial<Record<WeekdayKey, StableInterval[]>>;
  overrides: StableOverride[];
};

function configuredMinutes(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CADENCE_MINUTES;
  return Math.max(MINIMUM_CADENCE_MINUTES, Math.floor(parsed));
}

/** The loop is disabled by default and cannot run without OAuth/token configuration. */
export function googleBusinessSyncSettings(environment: NodeJS.ProcessEnv = process.env): GoogleBusinessSyncSettings {
  const cadenceMinutes = configuredMinutes(environment.GOOGLE_BUSINESS_SYNC_CADENCE_MINUTES);
  return {
    enabled: environment.GOOGLE_BUSINESS_SYNC_ENABLED === "true" && googleBusinessConfigured(environment),
    cadenceMinutes,
    cadenceMs: cadenceMinutes * 60_000,
  };
}

export function googleBusinessSyncBackoffMs(failureCount: number): number {
  const attempts = Math.max(1, Math.floor(Number.isFinite(failureCount) ? failureCount : 1));
  return Math.min(MAX_BACKOFF_MS, MINIMUM_CADENCE_MINUTES * 60_000 * (2 ** Math.min(attempts - 1, 10)));
}

function stableIntervals(intervals: OpeningInterval[]): StableInterval[] {
  return intervals
    .map((interval) => ({ open: interval.open, close: interval.close, endsNextDay: interval.endsNextDay === true || interval.close <= interval.open }))
    .sort((left, right) => `${left.open}:${left.close}:${left.endsNextDay}`.localeCompare(`${right.open}:${right.close}:${right.endsNextDay}`));
}

function stableHours(value: unknown): StableHours | null {
  const schedule = normalizeOpeningHours(value);
  if (!schedule) return null;
  const regular: Partial<Record<WeekdayKey, StableInterval[]>> = {};
  for (const day of WEEKDAY_KEYS) regular[day] = stableIntervals(schedule.regular[day] || []);
  const overrides = schedule.overrides
    .map((override) => ({
      date: override.date,
      ...(override.endDate ? { endDate: override.endDate } : {}),
      closed: override.closed,
      intervals: stableIntervals(override.intervals),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { timeZone: schedule.timeZone, regular, overrides };
}

/** Compares customer-visible hours only; source timestamps and metadata are not catalogue changes. */
export function googleBusinessHoursChanged(current: unknown, incoming: unknown): boolean {
  return JSON.stringify(stableHours(current)) !== JSON.stringify(stableHours(incoming));
}

function googleProvenanceChanged(current: unknown, incoming: unknown): boolean {
  const currentSource = normalizeOpeningHours(current)?.source;
  const incomingSource = normalizeOpeningHours(incoming)?.source;
  return currentSource?.mode !== incomingSource?.mode
    || currentSource?.locationName !== incomingSource?.locationName
    || currentSource?.revision !== incomingSource?.revision;
}

function isPikiManaged(value: unknown): boolean {
  return normalizeOpeningHours(value)?.source?.mode === "piki";
}

function safeSyncErrorCode(error: unknown): "GOOGLE_REAUTH_REQUIRED" | "GOOGLE_SYNC_FAILED" {
  return error instanceof Error && error.message === "GOOGLE_REAUTH_REQUIRED"
    ? "GOOGLE_REAUTH_REQUIRED"
    : "GOOGLE_SYNC_FAILED";
}

async function claimDueConnection(owner: string, now: Date): Promise<SyncConnection | null> {
  const claimed = await GoogleBusinessConnection.findOneAndUpdate(
    {
      status: "connected",
      googleLocationName: { $exists: true, $ne: "" },
      $and: [
        { $or: [{ nextSyncAt: null }, { nextSyncAt: { $exists: false } }, { nextSyncAt: { $lte: now } }] },
        { $or: [{ syncLockUntil: null }, { syncLockUntil: { $exists: false } }, { syncLockUntil: { $lte: now } }] },
      ],
    },
    { $set: { syncLockOwner: owner, syncLockUntil: new Date(now.getTime() + LOCK_LEASE_MS) } },
    { new: true, sort: { nextSyncAt: 1, _id: 1 } },
  ).select("+accessTokenEncrypted +refreshTokenEncrypted").exec();
  return claimed as SyncConnection | null;
}

async function releaseConnection(owner: string, connectionId: unknown, fields: Record<string, unknown>): Promise<void> {
  await GoogleBusinessConnection.updateOne(
    { _id: connectionId, syncLockOwner: owner },
    { $set: { ...fields, syncLockOwner: null, syncLockUntil: null } },
  ).exec();
}

async function syncClaimedConnection(connection: SyncConnection, owner: string, settings: GoogleBusinessSyncSettings, now: Date): Promise<"changed" | "unchanged" | "skipped" | "failed"> {
  const nextSyncAt = new Date(now.getTime() + settings.cadenceMs);
  try {
    const restaurant = await Restaurant.findById(connection.restaurantId).select("partnerProfile.openingHours").lean().exec() as RestaurantHoursRow | null;
    if (!restaurant) {
      const failures = Number(connection.syncFailureCount || 0) + 1;
      await releaseConnection(owner, connection._id, {
        lastSyncAt: now,
        lastSyncStatus: "error",
        lastSyncError: "RESTAURANT_NOT_FOUND",
        syncFailureCount: failures,
        nextSyncAt: new Date(now.getTime() + googleBusinessSyncBackoffMs(failures)),
      });
      return "failed";
    }

    // A partner's explicitly saved PIKI schedule always wins. The OAuth/location
    // record remains linked and is retried only after a deliberate source change.
    if (isPikiManaged(restaurant.partnerProfile?.openingHours)) {
      await releaseConnection(owner, connection._id, { nextSyncAt });
      return "skipped";
    }

    const locationName = String(connection.googleLocationName || "");
    const googleLocation = await readGoogleLocation(connection, locationName);
    const incomingHours = fromGoogleLocationHours(googleLocation, restaurant.partnerProfile?.openingHours);
    const hoursChanged = googleBusinessHoursChanged(restaurant.partnerProfile?.openingHours, incomingHours);
    const provenanceChanged = googleProvenanceChanged(restaurant.partnerProfile?.openingHours, incomingHours);

    let wroteHours = false;
    if (hoursChanged || provenanceChanged) {
      const writeResult = await Restaurant.updateOne(
        { _id: restaurant._id, "partnerProfile.openingHours.source.mode": { $ne: "piki" } },
        { $set: { "partnerProfile.openingHours": incomingHours } },
      ).exec();
      wroteHours = writeResult.modifiedCount > 0;
    }

    await releaseConnection(owner, connection._id, {
      lastSyncAt: now,
      lastSyncStatus: "success",
      lastSyncError: "",
      lastGoogleUpdatedAt: now,
      syncFailureCount: 0,
      nextSyncAt,
    });

    if (hoursChanged && wroteHours) {
      await publishCatalogUpdate(restaurant._id, "restaurant.opening_hours.google_sync");
      return "changed";
    }
    return "unchanged";
  } catch (error) {
    const failures = Number(connection.syncFailureCount || 0) + 1;
    const code = safeSyncErrorCode(error);
    await releaseConnection(owner, connection._id, {
      lastSyncAt: now,
      lastSyncStatus: "error",
      lastSyncError: code,
      ...(code === "GOOGLE_REAUTH_REQUIRED" ? { status: "needs_reauth", nextSyncAt: null } : { syncFailureCount: failures, nextSyncAt: new Date(now.getTime() + googleBusinessSyncBackoffMs(failures)) }),
    });
    return "failed";
  }
}

export async function runGoogleBusinessSyncBatch(settings = googleBusinessSyncSettings()): Promise<{ changed: number; unchanged: number; skipped: number; failed: number }> {
  const result = { changed: 0, unchanged: 0, skipped: 0, failed: 0 };
  if (!settings.enabled) return result;
  const owner = `google-business-sync-${process.pid}-${randomUUID()}`;
  for (let index = 0; index < MAX_BATCH_SIZE; index += 1) {
    const connection = await claimDueConnection(owner, new Date());
    if (!connection) break;
    const outcome = await syncClaimedConnection(connection, owner, settings, new Date());
    result[outcome] += 1;
  }
  return result;
}

let workerTimer: ReturnType<typeof setInterval> | undefined;
let workerRunning = false;

/** Starts a single in-process poller. Mongo leases make concurrent API replicas safe. */
export function startGoogleBusinessSyncWorker(): void {
  const settings = googleBusinessSyncSettings();
  if (!settings.enabled || workerTimer) return;
  const poll = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await runGoogleBusinessSyncBatch(settings);
    } catch {
      // Per-connection failures are persisted above. Do not log OAuth responses,
      // tokens or raw provider errors from this background loop.
    } finally {
      workerRunning = false;
    }
  };
  workerTimer = setInterval(() => { void poll(); }, settings.cadenceMs);
  workerTimer.unref();
  void poll();
}

export function stopGoogleBusinessSyncWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
}
