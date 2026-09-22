import mongoose, { InferSchemaType, Schema } from "mongoose";

const geoPoint = new Schema({ type: { type: String, enum: ["Point"], default: "Point" }, coordinates: { type: [Number], default: [0, 0] } }, { _id: false });
const menuItem = new Schema({ id: { type: String, required: true }, name: { type: String, required: true }, description: { type: String, default: "" }, price: { type: Number, required: true, min: 0 }, vegetarian: { type: Boolean, default: false }, popular: { type: Boolean, default: false } }, { _id: false });

const restaurantSchema = new Schema({
  slug: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true },
  cuisine: { type: String, required: true },
  category: { type: String, required: true, index: true },
  tagline: { type: String, default: "" },
  etaMinutes: { type: [Number], default: [20, 35] },
  deliveryFeeCents: { type: Number, default: 0, min: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  reviews: { type: Number, default: 0, min: 0 },
  promoted: { type: Boolean, default: false },
  image: { type: String, default: "" },
  accent: { type: String, default: "#171715" },
  onboardingStatus: { type: String, enum: ["pending_review", "approved", "rejected", "suspended"], default: "approved", index: true },
  isActive: { type: Boolean, default: true, index: true },
  email: { type: String, default: "" },
  phone: { type: String, default: "" },
  address: { type: String, default: "" },
  location: { type: geoPoint, default: undefined },
  menu: { type: [menuItem], default: [] },
}, { timestamps: true, collection: "restaurants" });
restaurantSchema.index({ location: "2dsphere" }, { sparse: true });
restaurantSchema.index({ isActive: 1, category: 1, rating: -1 });

const riderSchema = new Schema({ name: { type: String, required: true }, email: { type: String, required: true, unique: true }, fleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null }, status: { type: String, enum: ["offline", "available", "busy", "paused"], default: "offline", index: true }, vehicle: { type: String, enum: ["bike", "scooter", "car"], default: "scooter" }, location: { type: geoPoint, default: undefined }, lastLocationAt: { type: Date, default: null } }, { timestamps: true, collection: "riders" });
riderSchema.index({ location: "2dsphere" }, { sparse: true });

const fleetSchema = new Schema({ name: { type: String, required: true, unique: true }, managerName: { type: String, default: "" }, isActive: { type: Boolean, default: true }, serviceZones: { type: [String], default: [] } }, { timestamps: true, collection: "fleets" });

const orderSchema = new Schema({ publicCode: { type: String, required: true, unique: true, index: true }, restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true }, customerId: { type: String, default: null, index: true }, riderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true }, status: { type: String, enum: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way", "delivered", "cancelled"], default: "pending", index: true }, subtotalCents: { type: Number, default: 0 }, deliveryFeeCents: { type: Number, default: 0 }, totalCents: { type: Number, default: 0 }, deliveredAt: { type: Date, default: null } }, { timestamps: true, collection: "orders" });
orderSchema.index({ status: 1, createdAt: -1 });

export type RestaurantDocument = InferSchemaType<typeof restaurantSchema>;
export const Restaurant = mongoose.models.Restaurant || mongoose.model("Restaurant", restaurantSchema);
export const Rider = mongoose.models.Rider || mongoose.model("Rider", riderSchema);
export const Fleet = mongoose.models.Fleet || mongoose.model("Fleet", fleetSchema);
export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);

export async function ensureIndexes() { await Promise.all([Restaurant.init(), Rider.init(), Fleet.init(), Order.init()]); }
