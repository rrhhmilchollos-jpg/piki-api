import { Order } from "./models.js";
import { escapeCorporateHtml, sendCorporateEmail } from "./corporateEmail.js";

/**
 * Extracto diario de la operación: pedidos, cancelaciones y dinero.
 *
 * Se calcula sobre el día natural de Madrid, no sobre UTC, para que el cierre
 * coincida con el día en el que trabaja el equipo.
 */
export const BUSINESS_SUMMARY_RECIPIENT = (
  process.env.BUSINESS_SUMMARY_EMAIL ||
  process.env.ORDER_ALERT_EMAIL ||
  "rrhh.milchollos@gmail.com"
).trim();

function madridParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

export function madridDayRange(reference = new Date()): { start: Date; end: Date; label: string } {
  const { year, month, day } = madridParts(reference);
  const noonUtcGuess = new Date(`${year}-${month}-${day}T12:00:00Z`);
  const offsetMinutes = Math.round((Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0) - noonUtcGuess.getTime()) / 60000);
  const start = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0) + offsetMinutes * 60000);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000), label: `${day}/${month}/${year}` };
}

export function madridClock(date = new Date()): { hour: number; minute: number; label: string } {
  const { hour, minute } = madridParts(date);
  return { hour: Number(hour), minute: Number(minute), label: `${hour}:${minute}` };
}

export interface DailyBusinessSummary {
  label: string;
  startIso: string;
  endIso: string;
  created: number;
  delivered: number;
  cancelled: number;
  open: number;
  cashCollectedCents: number;
  cardCapturedCents: number;
  pendingCents: number;
  grossCents: number;
  averageTicketCents: number;
  byPaymentMethod: Record<string, number>;
  topStores: Array<{ name: string; orders: number; cents: number }>;
}

function euro(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

export async function buildDailyBusinessSummary(reference = new Date()): Promise<DailyBusinessSummary> {
  const { start, end, label } = madridDayRange(reference);
  const scope = { createdAt: { $gte: start, $lt: end } };
  const orders = (await Order.find(scope)
    .select("status paymentMethod paymentState totalCents cashCollectedCents restaurantId createdAt isTestOrder")
    .lean()
    .exec()) as any[];
  const real = orders.filter((order) => !order.isTestOrder);

  const summary: DailyBusinessSummary = {
    label,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    created: real.length,
    delivered: 0,
    cancelled: 0,
    open: 0,
    cashCollectedCents: 0,
    cardCapturedCents: 0,
    pendingCents: 0,
    grossCents: 0,
    averageTicketCents: 0,
    byPaymentMethod: {},
    topStores: [],
  };
  const storeTotals = new Map<string, { orders: number; cents: number }>();

  for (const order of real) {
    const total = Number(order.totalCents) || 0;
    const method = String(order.paymentMethod || "unknown");
    summary.byPaymentMethod[method] = (summary.byPaymentMethod[method] || 0) + 1;
    if (order.status === "delivered") {
      summary.delivered += 1;
      summary.grossCents += total;
      if (method === "cash") summary.cashCollectedCents += Number(order.cashCollectedCents) || total;
      else summary.cardCapturedCents += total;
    } else if (order.status === "cancelled") {
      summary.cancelled += 1;
    } else {
      summary.open += 1;
      summary.pendingCents += total;
    }
    if (order.restaurantId) {
      const key = String(order.restaurantId);
      const current = storeTotals.get(key) || { orders: 0, cents: 0 };
      current.orders += 1;
      current.cents += total;
      storeTotals.set(key, current);
    }
  }

  summary.averageTicketCents = summary.delivered ? Math.round(summary.grossCents / summary.delivered) : 0;
  summary.topStores = [...storeTotals.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 5)
    .map((row) => ({ name: row.name.slice(-6), orders: row.orders, cents: row.cents }));
  return summary;
}

export async function sendDailyBusinessSummary(reference = new Date()): Promise<{ sent: boolean; error?: string; summary: DailyBusinessSummary }> {
  const summary = await buildDailyBusinessSummary(reference);
  const methods = Object.entries(summary.byPaymentMethod)
    .map(([method, count]) => `${method}: ${count}`)
    .join(" · ") || "sin pedidos";
  const subject = `Extracto PIKI ${summary.label} · ${summary.created} pedidos · ${euro(summary.grossCents)} cobrados`;
  const text = [
    `Extracto del día ${summary.label} (hora de Madrid).`,
    "",
    `Pedidos creados: ${summary.created}`,
    `Entregados: ${summary.delivered}`,
    `Cancelados: ${summary.cancelled}`,
    `En curso al cierre: ${summary.open}`,
    "",
    `Cobrado en efectivo: ${euro(summary.cashCollectedCents)}`,
    `Cobrado con tarjeta: ${euro(summary.cardCapturedCents)}`,
    `Total cobrado: ${euro(summary.grossCents)}`,
    `Pendiente de cobro: ${euro(summary.pendingCents)}`,
    `Ticket medio: ${euro(summary.averageTicketCents)}`,
    `Métodos: ${methods}`,
  ].join("\n");
  const html = `<div style="background:#f4f6f8;padding:24px;font-family:Arial,sans-serif;color:#172238"><div style="max-width:640px;margin:auto;background:#fff;border-radius:16px;overflow:hidden"><div style="background:#172238;color:#fff;padding:22px"><strong style="font-size:22px">PIKI · Administración</strong><p style="margin:6px 0 0">Extracto del día ${escapeCorporateHtml(summary.label)}</p></div><div style="padding:24px"><p style="font-size:30px;margin:0 0 4px"><strong>${escapeCorporateHtml(euro(summary.grossCents))}</strong></p><p style="margin:0 0 18px;color:#5b6b7a">cobrado hoy · ${summary.created} pedidos</p><table style="width:100%;border-collapse:collapse;font-size:14px"><tr><td style="padding:5px 0;color:#5b6b7a">Entregados</td><td style="padding:5px 0;text-align:right">${summary.delivered}</td></tr><tr><td style="padding:5px 0;color:#5b6b7a">Cancelados</td><td style="padding:5px 0;text-align:right">${summary.cancelled}</td></tr><tr><td style="padding:5px 0;color:#5b6b7a">En curso al cierre</td><td style="padding:5px 0;text-align:right">${summary.open}</td></tr><tr><td style="padding:5px 0;color:#5b6b7a">Efectivo</td><td style="padding:5px 0;text-align:right">${escapeCorporateHtml(euro(summary.cashCollectedCents))}</td></tr><tr><td style="padding:5px 0;color:#5b6b7a">Tarjeta</td><td style="padding:5px 0;text-align:right">${escapeCorporateHtml(euro(summary.cardCapturedCents))}</td></tr><tr><td style="padding:5px 0;color:#5b6b7a">Pendiente</td><td style="padding:5px 0;text-align:right">${escapeCorporateHtml(euro(summary.pendingCents))}</td></tr><tr><td style="padding:5px 0;color:#5b6b7a">Ticket medio</td><td style="padding:5px 0;text-align:right">${escapeCorporateHtml(euro(summary.averageTicketCents))}</td></tr></table><p style="margin:16px 0 0;font-size:13px;color:#5b6b7a">Métodos de pago · ${escapeCorporateHtml(methods)}</p></div></div></div>`;
  const result = await sendCorporateEmail({
    recipientEmail: BUSINESS_SUMMARY_RECIPIENT,
    subject,
    text,
    html,
    idempotencyKey: `piki-daily-summary-${summary.label}-${summary.created}`,
  });
  return { ...result, summary };
}
