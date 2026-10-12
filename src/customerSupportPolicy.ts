import { randomBytes } from "node:crypto";
import { z } from "zod";

export const customerSupportCreateSchema = z.object({
  orderRef: z.string().trim().max(120).optional(),
  category: z.enum(["order", "account", "technical", "billing", "finance", "other"]).default("order"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  subject: z.string().trim().min(3).max(180),
  description: z.string().trim().min(3).max(4000),
});

export function customerSupportTicketNumber(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `SUP-${date}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

type TicketMessageLike = { senderRole?: unknown; senderName?: unknown; body?: unknown; createdAt?: unknown };
type CustomerTicketLike = {
  _id?: unknown;
  ticketNumber?: unknown;
  subject?: unknown;
  description?: unknown;
  category?: unknown;
  priority?: unknown;
  status?: unknown;
  messages?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export function customerSupportTicketView(value: unknown) {
  const ticket = (value && typeof value === "object" ? value : {}) as CustomerTicketLike;
  const messages = Array.isArray(ticket.messages) ? (ticket.messages as TicketMessageLike[]).map((message) => ({
    senderRole: String(message.senderRole || ""),
    senderName: String(message.senderName || ""),
    body: String(message.body || ""),
    createdAt: message.createdAt ?? null,
  })) : [];
  return {
    _id: String(ticket._id || ""),
    ticketNumber: String(ticket.ticketNumber || ""),
    subject: String(ticket.subject || ""),
    description: String(ticket.description || ""),
    category: String(ticket.category || "other"),
    priority: String(ticket.priority || "normal"),
    status: String(ticket.status || "open"),
    messages,
    createdAt: ticket.createdAt ?? null,
    updatedAt: ticket.updatedAt ?? null,
  };
}
