import { versionPolicySchema, type VersionPolicy } from "./appVersion.js";

/** Native clients keep the server-authoritative compatibility policy. */
export function nativeReleasePolicy(policy: VersionPolicy, clientVersion?: string, clientBuildId?: string): VersionPolicy {
  const installed = versionPolicySchema.safeParse({
    version: clientVersion,
    minimumVersion: "0.0.0",
    buildId: clientBuildId,
    forceUpdate: false,
  });
  if (!installed.success) return policy;
  return { ...policy, buildId: installed.data.buildId };
}
