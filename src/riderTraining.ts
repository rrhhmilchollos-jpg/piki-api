import crypto from "node:crypto";
import mongoose, { Schema } from "mongoose";

export const PIKI_PRL_COURSE_SLUG = "piki-1-prl-riders";
export const PIKI_PRL_COURSE_VERSION = 1;

export type TrainingQuestion = {
  id: string;
  module: string;
  prompt: string;
  options: string[];
};

type InternalQuestion = TrainingQuestion & { answerIndex: number };

const internalQuestions: InternalQuestion[] = [
  { id: "road-01", module: "Seguridad vial", prompt: "Antes de iniciar un reparto, ¿qué debes comprobar?", options: ["Solo la batería del móvil", "Frenos, neumáticos, luces, casco y batería/combustible", "Que el pedido pese poco"], answerIndex: 1 },
  { id: "ppe-01", module: "EPI y visibilidad", prompt: "¿Qué protege mejor frente a baja visibilidad?", options: ["Chaleco reflectante y luces operativas", "Ropa oscura", "Circular sin luces para ahorrar batería"], answerIndex: 0 },
  { id: "load-01", module: "Carga y entrega", prompt: "¿Cómo debe transportarse la carga?", options: ["Suelta para acceder rápido", "Estable, cerrada y sin comprometer el control del vehículo", "En la mano si pesa menos de 5 kg"], answerIndex: 1 },
  { id: "weather-01", module: "Clima", prompt: "Si las condiciones meteorológicas impiden circular con seguridad, debes…", options: ["Continuar siempre para no retrasar el pedido", "Parar en un lugar seguro y comunicar la incidencia", "Aumentar la velocidad"], answerIndex: 1 },
  { id: "incident-01", module: "Accidentes y SOS", prompt: "Ante un accidente con personas heridas, la primera actuación es…", options: ["Proteger la zona, avisar a emergencias y prestar ayuda sin ponerse en riesgo", "Mover siempre a la persona herida", "Publicar una foto del accidente"], answerIndex: 0 },
  { id: "fatigue-01", module: "Fatiga", prompt: "¿Qué conducta es preventiva ante fatiga o somnolencia?", options: ["Tomar más pedidos", "Parar, descansar y avisar al responsable", "Usar el móvil mientras se conduce"], answerIndex: 1 },
  { id: "data-01", module: "Privacidad", prompt: "La dirección y el teléfono del cliente deben…", options: ["Compartirse en grupos de mensajería", "Usarse solo para el servicio y protegerse de accesos no autorizados", "Guardarse en el móvil personal indefinidamente"], answerIndex: 1 },
  { id: "hygiene-01", module: "Higiene", prompt: "La bolsa de transporte debe mantenerse…", options: ["Limpia, cerrada y en condiciones adecuadas para el pedido", "Abierta para ventilar durante el trayecto", "Junto a objetos personales"], answerIndex: 0 },
];

export const publicTrainingQuestions: TrainingQuestion[] = internalQuestions.map(({ answerIndex: _answerIndex, ...question }) => question);

export const riderTrainingCourseSchema = new Schema({
  slug: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  version: { type: Number, required: true, min: 1 },
  purpose: { type: String, required: true },
  questions: { type: [Schema.Types.Mixed], required: true },
  answerKey: { type: Schema.Types.Mixed, required: true, select: false },
  passPercent: { type: Number, required: true, min: 0, max: 100, default: 75 },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true, collection: "rider_training_courses" });

export const riderTrainingAssignmentSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
  courseId: { type: Schema.Types.ObjectId, ref: "RiderTrainingCourse", required: true, index: true },
  riderApplicationId: { type: Schema.Types.ObjectId, ref: "RiderApplication", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", required: true, index: true },
  status: { type: String, enum: ["assigned", "in_progress", "submitted", "reviewed", "expired"], default: "assigned", index: true },
  accessTokenHash: { type: String, required: true, unique: true, select: false },
  tokenPrefix: { type: String, required: true, maxlength: 12 },
  expiresAt: { type: Date, required: true, index: true },
  consentAcceptedAt: { type: Date, default: null },
  submittedAt: { type: Date, default: null },
  reviewDecision: { type: String, enum: ["pending", "approved", "needs_review", "rejected"], default: "pending" },
  reviewNotes: { type: String, default: "", maxlength: 2000 },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null },
  reviewedAt: { type: Date, default: null },
}, { timestamps: true, collection: "rider_training_assignments" });
riderTrainingAssignmentSchema.index({ tenantId: 1, riderId: 1, courseId: 1 }, { unique: true });

export const riderTrainingResponseSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
  assignmentId: { type: Schema.Types.ObjectId, ref: "RiderTrainingAssignment", required: true, unique: true, index: true },
  answers: { type: [Schema.Types.Mixed], required: true },
  scorePercent: { type: Number, required: true, min: 0, max: 100 },
  passedKnowledgeThreshold: { type: Boolean, required: true },
  consentTextVersion: { type: String, required: true },
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: "rider_training_responses" });

export const RiderTrainingCourse = mongoose.models.RiderTrainingCourse || mongoose.model("RiderTrainingCourse", riderTrainingCourseSchema);
export const RiderTrainingAssignment = mongoose.models.RiderTrainingAssignment || mongoose.model("RiderTrainingAssignment", riderTrainingAssignmentSchema);
export const RiderTrainingResponse = mongoose.models.RiderTrainingResponse || mongoose.model("RiderTrainingResponse", riderTrainingResponseSchema);

export function trainingToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function trainingTokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function scoreTrainingAnswers(answers: Record<string, number>, passPercent = 75) {
  const valid = internalQuestions.filter((question) => Number.isInteger(answers[question.id]) && answers[question.id] >= 0 && answers[question.id] < question.options.length);
  const correct = valid.filter((question) => answers[question.id] === question.answerIndex).length;
  const scorePercent = internalQuestions.length ? Math.round((correct / internalQuestions.length) * 100) : 0;
  return { scorePercent, passedKnowledgeThreshold: valid.length === internalQuestions.length && scorePercent >= passPercent, answered: valid.length, total: internalQuestions.length };
}

export async function ensurePikiPrlCourse() {
  return RiderTrainingCourse.findOneAndUpdate(
    { slug: PIKI_PRL_COURSE_SLUG, version: PIKI_PRL_COURSE_VERSION },
    { $set: { title: "PIKI 1 · Prevención de Riesgos Laborales para Riders", purpose: "Formación de conocimientos preventivos y operativos. No constituye una valoración médica, psicológica ni psicomotriz.", questions: publicTrainingQuestions, answerKey: Object.fromEntries(internalQuestions.map((question) => [question.id, question.answerIndex])), passPercent: 75, active: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).select("slug title version purpose questions passPercent active").lean().exec();
}
