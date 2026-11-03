import { Restaurant } from "./models.js";
import { escapeCorporateHtml, sendCorporateEmail } from "./corporateEmail.js";

/**
 * Aviso por correo de cada pedido nuevo confirmado por un cliente real.
 *
 * Se envía en segundo plano: si el correo falla, el pedido nunca se cae ni se
 * retrasa. Los pedidos marcados como prueba quedan fuera para no ensuciar la
 * bandeja con simulaciones.
 */
export const ORDER_ALERT_RECIPIENT = (process.env.ORDER_ALERT_EMAIL || "rrhh.milchollos@gmail.com").trim();

/** Remitente propio para los avisos de operación; si el buzón no existe se ignora. */
export const ORDER_ALERT_FROM = (process.env.ORDER_ALERT_FROM || "").trim() || undefined;

function euro(cents: number | undefined): string {
  return `${((Number(cents) || 0) / 100).toFixed(2).replace(".", ",")} €`;
}

export async function notifyOrderPlaced(order: any): Promise<{ sent: boolean; error?: string }> {
  try {
    if (!order || order.isTestOrder) return { sent: false, error: "ORDER_ALERT_SKIPPED" };
    const reference = order.publicCode || String(order._id);
    const restaurant = order.restaurantId
      ? ((await Restaurant.findById(order.restaurantId).select("name address city").lean().catch(() => null)) as any)
      : null;
    const items: Array<{ name?: string; quantity?: number; lineTotalCents?: number }> = Array.isArray(order.items) ? order.items : [];
    const lines = items.map((item) => `· ${Number(item.quantity) || 1} × ${item.name || "Producto"} — ${euro(item.lineTotalCents)}`);
    const method =
      order.paymentMethod === "cash"
        ? "Efectivo al recibir (tarjeta retenida como garantía)"
        : order.paymentMethod === "cash_at_door"
          ? "Efectivo al recibir"
          : "Tarjeta (cobro del total)";
    const address = [order.deliveryAddress?.street || order.deliveryAddress?.line1, order.deliveryAddress?.city].filter(Boolean).join(", ");
    const subject = `Nuevo pedido ${reference} · ${restaurant?.name || "Comercio"} · ${euro(order.totalCents)}`;
    const text = [
      `Pedido ${reference} confirmado por un cliente.`,
      "",
      `Comercio: ${restaurant?.name || "—"}`,
      `Cliente: ${order.customerName || "Cliente PIKI"}`,
      `Importe: ${euro(order.totalCents)} (comida ${euro(order.subtotalCents)} · envío ${euro(order.deliveryFeeCents)} · servicio ${euro(order.serviceFeeCents)})`,
      `Pago: ${method}`,
      `Entrega: ${address || "—"}`,
      "",
      "Productos:",
      ...(lines.length ? lines : ["· sin líneas registradas"]),
      "",
      "Panel: https://admin.pikidelivery.com/piki/pedidos",
    ].join("\n");
    const html = `<div style="background:#f4f6f8;padding:24px;font-family:Arial,sans-serif;color:#172238"><div style="max-width:640px;margin:auto;background:#fff;border-radius:16px;overflow:hidden"><div style="background:#d2ff59;padding:22px"><strong style="font-size:22px">PIKI DELIVERY</strong><p style="margin:6px 0 0">Pedido nuevo confirmado</p></div><div style="padding:24px;line-height:1.55"><h2 style="margin:0 0 8px">${escapeCorporateHtml(reference)}</h2><p style="margin:0 0 16px;font-size:26px"><strong>${escapeCorporateHtml(euro(order.totalCents))}</strong></p><table style="width:100%;border-collapse:collapse;font-size:14px"><tr><td style="padding:4px 0;color:#5b6b7a">Comercio</td><td style="padding:4px 0"><strong>${escapeCorporateHtml(restaurant?.name || "—")}</strong></td></tr><tr><td style="padding:4px 0;color:#5b6b7a">Cliente</td><td style="padding:4px 0">${escapeCorporateHtml(order.customerName || "Cliente PIKI")}</td></tr><tr><td style="padding:4px 0;color:#5b6b7a">Pago</td><td style="padding:4px 0">${escapeCorporateHtml(method)}</td></tr><tr><td style="padding:4px 0;color:#5b6b7a">Entrega</td><td style="padding:4px 0">${escapeCorporateHtml(address || "—")}</td></tr></table><h3 style="margin:20px 0 6px;font-size:15px">Productos</h3><p style="margin:0;font-size:14px;line-height:1.6">${(lines.length ? lines : ["· sin líneas registradas"]).map(escapeCorporateHtml).join("<br>")}</p><p style="margin:22px 0 0"><a href="https://admin.pikidelivery.com/piki/pedidos" style="background:#172238;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none">Abrir en administración</a></p></div></div></div>`;
    return await sendCorporateEmail({
      recipientEmail: ORDER_ALERT_RECIPIENT,
      fromEmail: ORDER_ALERT_FROM,
      subject,
      text,
      html,
      idempotencyKey: `piki-order-alert-${order._id}`,
    });
  } catch (error) {
    console.warn("Order alert failed", error instanceof Error ? error.name : "unknown");
    return { sent: false, error: "ORDER_ALERT_FAILED" };
  }
}


export async function notifyOrderCancelled(order: any, reason = ""): Promise<{ sent: boolean; error?: string }> {
  try {
    if (!order || order.isTestOrder) return { sent: false, error: "ORDER_ALERT_SKIPPED" };
    const reference = order.publicCode || String(order._id);
    const restaurant = order.restaurantId
      ? ((await Restaurant.findById(order.restaurantId).select("name").lean().catch(() => null)) as any)
      : null;
    const subject = `Pedido cancelado ${reference} · ${restaurant?.name || "Comercio"} · ${euro(order.totalCents)}`;
    const text = [
      `El pedido ${reference} se ha cancelado.`,
      "",
      `Comercio: ${restaurant?.name || "—"}`,
      `Cliente: ${order.customerName || "Cliente PIKI"}`,
      `Importe: ${euro(order.totalCents)}`,
      `Método: ${order.paymentMethod === "cash" ? "Efectivo" : "Tarjeta"}`,
      `Motivo: ${reason || "no indicado"}`,
      `Hora: ${new Date().toISOString()}`,
    ].join("\n");
    const html = `<div style="background:#fdf2f2;padding:24px;font-family:Arial,sans-serif;color:#3f1d1d"><div style="max-width:620px;margin:auto;background:#fff;border-radius:16px;overflow:hidden"><div style="background:#f3d7d7;padding:22px"><strong style="font-size:22px">PIKI · Administración</strong><p style="margin:6px 0 0">Pedido cancelado</p></div><div style="padding:24px;line-height:1.55"><h2 style="margin:0 0 8px">${escapeCorporateHtml(reference)}</h2><p style="margin:0 0 14px;font-size:24px"><strong>${escapeCorporateHtml(euro(order.totalCents))}</strong></p><p style="margin:0 0 8px">Comercio: <strong>${escapeCorporateHtml(restaurant?.name || "—")}</strong></p><p style="margin:0 0 8px">Cliente: ${escapeCorporateHtml(order.customerName || "Cliente PIKI")}</p><p style="margin:0">Motivo: ${escapeCorporateHtml(reason || "no indicado")}</p></div></div></div>`;
    return await sendCorporateEmail({
      recipientEmail: ORDER_ALERT_RECIPIENT,
      fromEmail: ORDER_ALERT_FROM,
      subject,
      text,
      html,
      idempotencyKey: `piki-order-cancel-${order._id}-${Date.now()}`,
    });
  } catch (error) {
    console.warn("Cancel alert failed", error instanceof Error ? error.name : "unknown");
    return { sent: false, error: "ORDER_ALERT_FAILED" };
  }
}
