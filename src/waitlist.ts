import { Router } from "express";
import { model, Schema } from "mongoose";

/**
 * Lista de espera de la campaña de Navidad.
 *
 * El correo es único a nivel de base de datos: si alguien pulsa dos veces el
 * botón, el segundo intento no crea un duplicado y la respuesta sigue siendo
 * correcta para el usuario (200 con existing: true).
 */
const WaitlistSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, default: null },
    source: { type: String, default: "navidad_2026" },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

WaitlistSchema.index({ createdAt: -1 });

export const WaitlistEntry = model("WaitlistEntry", WaitlistSchema);

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

export const waitlistRouter = Router();

waitlistRouter.post("/api/v1/waitlist", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return res.status(400).json({ error: "INVALID_EMAIL" });
  }

  try {
    const entry = await WaitlistEntry.create({
      email,
      name: req.body?.name ? String(req.body.name).slice(0, 120) : null,
    });
    return res.status(201).json({ ok: true, id: String(entry._id) });
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code === 11000) return res.status(200).json({ ok: true, existing: true });
    return res.status(500).json({ error: "WAITLIST_FAILED" });
  }
});

waitlistRouter.get("/api/v1/waitlist/count", async (_req, res) => {
  try {
    const total = await WaitlistEntry.countDocuments();
    return res.json({ total });
  } catch {
    return res.status(500).json({ error: "WAITLIST_COUNT_FAILED" });
  }
});
