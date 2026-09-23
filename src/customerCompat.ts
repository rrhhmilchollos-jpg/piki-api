import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { Order, Restaurant, CustomerAccount } from "./models.js";
import { createCheckoutSession } from "./stripe.js";

const COOKIE = "piki_customer_session";
const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
const hashPassword = (value: string, salt = randomBytes(16).toString("hex")) => `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
const checkPassword = (value: string, encoded: string) => {
  const [salt, digest] = encoded.split(":");
  if (!salt || !digest) return false;
  const actual = scryptSync(value, salt, 64);
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const publicUser = (user: any) => user ? ({ id: String(user._id), name: user.name, email: user.email, role: "user", createdAt: user.createdAt, lastSignedIn: user.lastSignedIn }) : null;

function inputOf(req: Request): any {
  const body = req.body ?? {};
  if (body.json) return body.json;
  const first = body["0"];
  if (first?.json) return first.json;
  if (typeof req.query.input === "string") {
    try { const parsed = JSON.parse(req.query.input); return parsed.json ?? parsed; } catch { return {}; }
  }
  return body;
}
function reply(res: Response, value: unknown) { return res.json({ result: { data: { json: value } } }); }
function fail(res: Response, message: string, code = "BAD_REQUEST") { return res.status(400).json({ error: { json: { message, data: { code } } } }); }
function getSession(req: Request) {
  const header = req.header("x-piki-session");
  if (header) return header;
  const cookie = req.header("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return cookie ? cookie.slice(COOKIE.length + 1) : null;
}
async function currentUser(req: Request) { const raw = getSession(req); return raw ? CustomerAccount.findOne({ sessionHash: hashToken(raw) }).lean().exec() : null; }
function setSession(res: Response, userId: string) { const raw = randomBytes(32).toString("base64url"); void CustomerAccount.updateOne({ _id: userId }, { $set: { sessionHash: hashToken(raw), lastSignedIn: new Date() } }).exec(); res.setHeader("Set-Cookie", `${COOKIE}=${raw}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=None`); }
function restaurantView(row: any) {
  return { id: String(row._id), name: row.name, cuisine: row.cuisine, category: row.category, tagline: row.tagline || "Descubre este establecimiento en PIKI.", eta: `${row.etaMinutes?.[0] || 20}–${row.etaMinutes?.[1] || 35} min`, fee: (row.deliveryFeeCents || 0) / 100, rating: row.rating || 0, reviews: row.reviews || 0, promoted: row.promoted, image: row.image || "", accent: row.accent || "#FFD72E", menu: (row.menu || []).map((item: any) => ({ id: item.id, name: item.name, description: item.description || "", price: item.price, vegetarian: Boolean(item.vegetarian), popular: Boolean(item.popular) })) };
}

export async function handleCustomerTrpc(req: Request, res: Response) {
  const procedure = String(req.params.procedure || "");
  const input = inputOf(req);
  try {
    if (procedure === "catalog.list") {
      const filter: Record<string, unknown> = { isActive: true, onboardingStatus: "approved" };
      if (input?.category) filter.category = input.category;
      const rows = await Restaurant.find(filter).sort({ promoted: -1, rating: -1, reviews: -1 }).lean().exec();
      const query = String(input?.query || "").trim().toLowerCase();
      return reply(res, rows.map(restaurantView).filter((row) => !query || `${row.name} ${row.cuisine} ${row.category}`.toLowerCase().includes(query)));
    }
    if (procedure === "catalog.byId") {
      const row = await Restaurant.findById(input?.id).lean().exec();
      return reply(res, row ? restaurantView(row) : null);
    }
    if (procedure === "auth.me") return reply(res, await currentUser(req).then((user) => publicUser(user)));
    if (procedure === "auth.register") {
      const name = String(input?.name || "").trim(); const email = String(input?.email || "").trim().toLowerCase(); const password = String(input?.password || "");
      if (name.length < 2 || !email.includes("@") || password.length < 8) return fail(res, "Datos de cuenta no válidos");
      if (await CustomerAccount.exists({ email })) return fail(res, "Ya existe una cuenta con este email", "CONFLICT");
      const user = await CustomerAccount.create({ name, email, passwordHash: hashPassword(password) }); setSession(res, String(user._id)); return reply(res, { user: publicUser(user) });
    }
    if (procedure === "auth.login") {
      const email = String(input?.email || "").trim().toLowerCase(); const user = await CustomerAccount.findOne({ email }).exec();
      if (!user || !checkPassword(String(input?.password || ""), user.passwordHash)) return fail(res, "Email o contraseña incorrectos", "UNAUTHORIZED");
      setSession(res, String(user._id)); return reply(res, { user: publicUser(user) });
    }
    if (procedure === "auth.logout") { res.clearCookie(COOKIE); return reply(res, { success: true }); }
    if (procedure === "order.create" || procedure === "order.checkout") {
      const user = await currentUser(req) as any;
      if (!user) return fail(res, "Debes iniciar sesión para realizar pedidos", "AUTH_REQUIRED");
      const restaurant = await Restaurant.findById(input?.restaurantId).lean().exec() as any;
      if (!restaurant) return fail(res, "Restaurante no encontrado", "NOT_FOUND");
      const requested = Array.isArray(input?.items) ? input.items : [];
      const items = requested.map((line: any) => { const item = restaurant.menu.find((candidate: any) => candidate.id === line.id); return item ? { itemId: item.id, name: item.name, quantity: Number(line.quantity), unitPriceCents: Math.round(item.price * 100) } : null; });
      if (!items.length || items.some((item: any) => !item || !Number.isInteger(item.quantity) || item.quantity < 1)) return fail(res, "La cesta no es válida");
      const normalized = items as Array<{itemId: string; name: string; quantity: number; unitPriceCents: number}>;
      const subtotalCents = normalized.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0); const deliveryCents = restaurant.deliveryFeeCents || 0; const serviceCents = 79; const totalCents = subtotalCents + deliveryCents + serviceCents;
      const code = `PIKI-${Date.now().toString(36).toUpperCase()}`;
      const order = await Order.create({ publicCode: code, restaurantId: restaurant._id, customerId: user ? String(user._id) : null, items: normalized, deliveryAddress: input.address, subtotalCents, deliveryFeeCents: deliveryCents, totalCents, paymentState: "pending", statusHistory: [{ status: "pending", actorRole: "customer", reason: "Pedido creado" }] });
      if (procedure === "order.create") return reply(res, { id: code, restaurant: restaurant.name, eta: `${restaurant.etaMinutes?.[0] || 20}–${restaurant.etaMinutes?.[1] || 35} min`, createdAt: Date.now(), status: order.status, totalCents });
      try {
        const session = await createCheckoutSession({ orderId: String(order._id), publicCode: code, origin: req.header("origin") || "https://app.pikidelivery.com", customerEmail: user?.email, items: normalized, deliveryFeeCents: deliveryCents, serviceFeeCents: serviceCents });
        await Order.updateOne({ _id: order._id }, { $set: { stripeCheckoutSessionId: session.id } }).exec(); return reply(res, { orderId: code, checkoutUrl: session.url, totalCents });
      } catch (error) {
        console.error(`[customerCompat] Stripe checkout failed for ${code}`, error instanceof Error ? error.message : error);
        await Order.updateOne({ _id: order._id }, { $set: { paymentState: "failed" } }).exec();
        return fail(res, "Stripe no está disponible en este momento. Comprueba la configuración de la cuenta de pruebas.", "STRIPE_UNAVAILABLE");
      }
    }
    return fail(res, `Procedimiento no soportado: ${procedure}`, "NOT_FOUND");
  } catch (error) { console.error(`[customerCompat] ${procedure}`, error); return fail(res, "Error interno de la plataforma", "INTERNAL_SERVER_ERROR"); }
}
