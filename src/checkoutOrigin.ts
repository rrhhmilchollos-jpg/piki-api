const CANONICAL_CHECKOUT_ORIGINS = new Set([
  "https://pikidelivery.com",
  "https://www.pikidelivery.com",
  "https://app.pikidelivery.com",
]);

function normalizedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function checkoutOrigin(raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.CUSTOMER_CHECKOUT_ALLOWED_ORIGINS || "")
    .split(",")
    .map((entry) => normalizedOrigin(entry.trim()))
    .filter((entry): entry is string => Boolean(entry));
  const allowed = new Set([...CANONICAL_CHECKOUT_ORIGINS, ...configured]);
  const fallback = normalizedOrigin(env.CUSTOMER_APP_URL) || "https://pikidelivery.com";
  allowed.add(fallback);
  const requested = normalizedOrigin(raw);
  return requested && allowed.has(requested) ? requested : fallback;
}
