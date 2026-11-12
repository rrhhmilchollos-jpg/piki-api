/** Only the Render-supplied Git commit is public; never return arbitrary env data. */
export function renderDeploymentCommit(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.RENDER_GIT_COMMIT?.trim();
  return value && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
}
