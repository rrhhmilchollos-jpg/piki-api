import mongoose from "mongoose";

const employeePasswordResetSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeAccount", required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true },
  // Historical links have no surface; newly issued links are app-specific.
  surface: { type: String, enum: ["admin", "partner", "rider", "fleet"], default: null },
  usedAt: { type: Date, default: null },
}, { timestamps: true, collection: "employee_password_resets" });

employeePasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmployeePasswordReset = mongoose.models.EmployeePasswordReset
  || mongoose.model("EmployeePasswordReset", employeePasswordResetSchema);
