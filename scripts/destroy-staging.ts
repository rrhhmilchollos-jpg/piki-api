import "dotenv/config";
import mongoose from "mongoose";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} es obligatorio para destruir staging`);
  return value;
};

if (process.env.PIKI_ENVIRONMENT !== "staging") throw new Error("Abortado: PIKI_ENVIRONMENT debe ser staging");
if (process.env.NODE_ENV === "production") throw new Error("Abortado: no se permite destruir desde NODE_ENV=production");
if (process.env.MONGODB_DB !== "piki_staging") throw new Error("Abortado: MONGODB_DB debe ser exactamente piki_staging");
if (process.env.STAGING_DELETE_CONFIRM !== "DELETE_PIKI_STAGING") throw new Error("Abortado: define STAGING_DELETE_CONFIRM=DELETE_PIKI_STAGING");

const mongoUri = required("MONGODB_URI");
const serviceId = required("RENDER_SERVICE_ID");
const renderToken = required("RENDER_API_TOKEN");
const renderOwnerId = process.env.RENDER_OWNER_ID?.trim();
const renderUrl = `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}`;

const answer = process.env.STAGING_DELETE_APPROVED;
if (answer !== "yes") throw new Error("Abortado: define STAGING_DELETE_APPROVED=yes para confirmar la eliminación irreversible");

await mongoose.connect(mongoUri, { dbName: "piki_staging", serverSelectionTimeoutMS: 10_000 });
const db = mongoose.connection.db;
if (!db) throw new Error("No se pudo abrir piki_staging");
const collections = await db.listCollections().toArray();
for (const collection of collections) await db.collection(collection.name).drop();
await mongoose.disconnect();

const headers: Record<string, string> = { Authorization: `Bearer ${renderToken}`, Accept: "application/json" };
if (renderOwnerId) headers["X-Render-Owner-Id"] = renderOwnerId;
const response = await fetch(renderUrl, { method: "DELETE", headers });
if (!response.ok) throw new Error(`Render no pudo eliminar el servicio (${response.status})`);
console.log(JSON.stringify({ deleted: true, database: "piki_staging", renderServiceId: serviceId }, null, 2));
