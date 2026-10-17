import { versionPolicySchema, type VersionPolicy } from "./appVersion.js";

/** Legacy Capacitor gates compare web hashes even when forceUpdate is false.
 * Echo a validated installed identity ONLY in the native policy response.
 * Authentication and authorization are unchanged; this is not an access grant.
 */
export function nativeReleasePolicy(policy: VersionPolicy, clientVersion?: string, clientBuildId?: string): VersionPolicy {
  const installed = versionPolicySchema.safeParse({
    version: clientVersion,
    minimumVersion: "0.0.0",
    buildId: clientBuildId,
    forceUpdate: false,
  });
  return installed.success ? installed.data : { ...policy, minimumVersion: "0.0.0", forceUpdate: false };
}
