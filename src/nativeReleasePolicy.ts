import { versionPolicySchema, type VersionPolicy } from "./appVersion.js";

/**
 * Native clients report their installed build for diagnostics. A hard block is
 * opt-in because an unpublished replacement must never trap every employee.
 */
export function nativeReleasePolicy(policy: VersionPolicy, clientVersion?: string, clientBuildId?: string): VersionPolicy {
  const installed = versionPolicySchema.safeParse({
    version: clientVersion,
    minimumVersion: "0.0.0",
    buildId: clientBuildId,
    forceUpdate: false,
  });
  if (!installed.success) return policy;
  const hardBlockEnabled = String(process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED || "false").trim().toLowerCase() === "true";
  return { ...policy, buildId: installed.data.buildId, ...(hardBlockEnabled ? {} : { minimumVersion: "0.0.0", forceUpdate: false }) };
}

/** Rider's version check and operational routes must enforce the same policy. */
export function riderClientReleasePolicy(policy: VersionPolicy, nativeContainer: boolean, clientVersion?: string, clientBuildId?: string): VersionPolicy {
  // Keep the native identity validation and explicit hard-block opt-in unchanged.
  // Legacy Rider bundles do not mark Capacitor; preserve the existing Rider
  // /app-version compatibility policy instead of imposing a web-only release.
  return nativeContainer
    ? nativeReleasePolicy(policy, clientVersion, clientBuildId)
    : { ...policy, minimumVersion: "0.0.0", forceUpdate: false };
}
