import crypto from "node:crypto";
import mongoose, { Schema } from "mongoose";

export const PRL_COURSE_VERSION = "2026.10";
export const PRL_PASS_MARK = 80;

export const prlQuestions = [
  { id: "q1", module: 1, text: "Antes de iniciar la jornada, ¿qué debes hacer?", options: ["Comprobar vehículo, batería, frenos, luces y teléfono", "Salir rápidamente para no retrasar pedidos", "Usar el móvil mientras conduces"], answer: 0 },
  { id: "q2", module: 2, text: "Durante la circulación y el reparto debes…", options: ["Adaptar velocidad y usar casco y elementos reflectantes cuando corresponda", "Circular siempre por la acera", "Manipular pedidos mientras conduces"], answer: 0 },
  { id: "q3", module: 3, text: "Para realizar una entrega segura…", options: ["Aparcar sin bloquear pasos y no usar el teléfono durante la marcha", "Dejar el vehículo en cualquier lugar", "Entregar mientras conduces"], answer: 0 },
  { id: "q4", module: 4, text: "Ante un accidente o riesgo grave…", options: ["Ponerte a salvo, llamar al 112 si procede y avisar al soporte", "Continuar la operación a cualquier precio", "Ocultar la incidencia"], answer: 0 },
  { id: "q5", module: 1, text: "Si detectas una avería que compromete tu seguridad…", options: ["No inicias la jornada y comunicas la incidencia", "La ignoras", "Aumentas la velocidad"], answer: 0 },
];

const attendanceSchema = new Schema({
  event: { type: String, enum: ["course_started", "module_viewed", "heartbeat", "assessment_submitted"], required: true },
  module: { type: Number, default: null },
  at: { type: Date, default: Date.now },
  ip: { type: String, default: "" },
  userAgent: { type: String, default: "" },
}, { _id: false });

const prlEnrollmentSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  leadKind: { type: String, enum: ["rider", "partner"], required: true, index: true },
  leadId: { type: Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  courseVersion: { type: String, required: true },
  status: { type: String, enum: ["issued", "started", "passed", "failed", "provider_confirmed"], default: "issued", index: true },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  answers: { type: Schema.Types.Mixed, default: {} },
  score: { type: Number, default: null, min: 0, max: 100 },
  passed: { type: Boolean, default: false },
  modulesViewed: { type: [Number], default: [] },
  attendance: { type: [attendanceSchema], default: [] },
  certificate: {
    status: { type: String, enum: ["not_eligible", "provider_pending", "issued"], default: "not_eligible" },
    serial: { type: String, default: null },
    issuer: { type: String, default: null },
    issuedAt: { type: Date, default: null },
    providerReference: { type: String, default: null },
  },
}, { timestamps: true, collection: "prl_enrollments" });
prlEnrollmentSchema.index({ leadKind: 1, leadId: 1, createdAt: -1 });

export const PrlEnrollment = mongoose.models.PrlEnrollment || mongoose.model("PrlEnrollment", prlEnrollmentSchema);

export function createPrlToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: crypto.createHash("sha256").update(token).digest("hex") };
}

export function hashPrlToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function publicPrlEnrollment(enrollment: any) {
  return {
    id: String(enrollment._id), name: enrollment.name, email: enrollment.email,
    courseVersion: enrollment.courseVersion, status: enrollment.status,
    startedAt: enrollment.startedAt, completedAt: enrollment.completedAt,
    score: enrollment.score, passed: enrollment.passed,
    modulesViewed: enrollment.modulesViewed || [],
    certificate: enrollment.certificate || { status: "not_eligible" },
  };
}

export function certificateMode() {
  return String(process.env.PRL_CERTIFICATE_MODE || "provider_pending").trim().toLowerCase();
}

export function certificateIssuer() {
  return String(process.env.PRL_CERTIFICATE_ISSUER || "").trim();
}
