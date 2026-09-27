import { z } from "zod";

export const PIKI_SURFACES = ["customer", "partner", "fleet", "admin", "rider"] as const;
export type PikiSurface = (typeof PIKI_SURFACES)[number];

export const versionPolicySchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  minimumVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  buildId: z.string().min(6).max(160),
  forceUpdate: z.boolean(),
}).strict().superRefine((value, context) => {
  if (compareSemver(value.minimumVersion, value.version) > 0) {
    context.addIssue({ code: "custom", message: "minimumVersion must not be newer than version" });
  }
});

export type VersionPolicy = z.infer<typeof versionPolicySchema>;
export type VersionPolicyMap = Record<PikiSurface, VersionPolicy>;

const fallbackPolicy: VersionPolicy = {
  version: "0.2.4",
  minimumVersion: "0.0.0",
  buildId: "initial-safe-policy",
  forceUpdate: false,
};

function semverParts(value: string): number[] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index] - b[index];
    if (difference) return difference;
  }
  return 0;
}

export function isPikiSurface(value: unknown): value is PikiSurface {
  return typeof value === "string" && (PIKI_SURFACES as readonly string[]).includes(value);
}

function parseEnvironmentPolicy(): VersionPolicyMap {
  const raw = process.env.PIKI_APP_VERSION_POLICY;
  if (!raw) return Object.fromEntries(PIKI_SURFACES.map((surface) => [surface, fallbackPolicy])) as VersionPolicyMap;
  const parsed = z.record(z.string(), versionPolicySchema).safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("PIKI_APP_VERSION_POLICY is invalid");
  const keys = Object.keys(parsed.data).sort();
  if (keys.length !== PIKI_SURFACES.length || keys.some((key, index) => key !== [...PIKI_SURFACES].sort()[index])) {
    throw new Error("PIKI_APP_VERSION_POLICY must define exactly customer, partner, fleet, admin and rider");
  }
  return Object.fromEntries(PIKI_SURFACES.map((surface) => [surface, parsed.data[surface]])) as VersionPolicyMap;
}

let policies: VersionPolicyMap = parseEnvironmentPolicy();
const releaseUrls: Record<PikiSurface, string> = {
  customer: "https://pikidelivery.com/release.json",
  partner: "https://partners.pikidelivery.com/release.json",
  fleet: "https://fleet.pikidelivery.com/release.json",
  admin: "https://admin.pikidelivery.com/release.json",
  rider: "https://riders.pikidelivery.com/release.json",
};
const lastSync = new Map<PikiSurface, number>();
const SYNC_INTERVAL_MS = 30_000;

export async function syncVersionPolicy(surface: PikiSurface): Promise<VersionPolicy> {
  const now = Date.now();
  if (now - (lastSync.get(surface) || 0) < SYNC_INTERVAL_MS) return policies[surface];
  lastSync.set(surface, now);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(releaseUrls[surface], { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`release metadata HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    const { surface: releaseSurface, ...releasePolicy } = body;
    if (releaseSurface !== surface) throw new Error("release metadata surface mismatch");
    const parsed = versionPolicySchema.safeParse(releasePolicy);
    if (!parsed.success) throw new Error("release metadata is invalid");
    policies = { ...policies, [surface]: parsed.data };
  } catch (error) {
    console.warn(`Release policy sync failed for ${surface}:`, error instanceof Error ? error.message : error);
  } finally {
    clearTimeout(timeout);
  }
  return policies[surface];
}

export function getVersionPolicy(surface: PikiSurface): VersionPolicy {
  return policies[surface];
}

export function setVersionPolicy(surface: PikiSurface, policy: VersionPolicy): VersionPolicy {
  policies = { ...policies, [surface]: policy };
  return policies[surface];
}

export function setAllVersionPolicies(next: VersionPolicyMap): void {
  policies = next;
}

/**
 * Mandatory updates are a compatibility decision, so they must be based on
 * ordered semantic versions. A build ID is diagnostic metadata only: hashes
 * cannot establish whether a different client is older or newer and therefore
 * must never lock a valid client out of login or operational API routes.
 */
export function requiresUpdate(
  policy: VersionPolicy,
  clientVersion?: string,
  _clientBuildId?: string,
  _surface?: PikiSurface,
): boolean {
  return Boolean(policy.forceUpdate && clientVersion && compareSemver(clientVersion, policy.minimumVersion) < 0);
}
