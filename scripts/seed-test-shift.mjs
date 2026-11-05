#!/usr/bin/env node
/**
 * Crea un turno de prueba para un Rider concreto y permite borrarlo después.
 *
 * Por defecto NO escribe nada: muestra qué haría. Hay que pasar --apply.
 *
 *   node scripts/seed-test-shift.mjs --email rider@ejemplo.com --in 10
 *   node scripts/seed-test-shift.mjs --email rider@ejemplo.com --in 10 --apply
 *   node scripts/seed-test-shift.mjs --email rider@ejemplo.com --clean --apply
 *
 * Requiere MONGODB_URI en el entorno (el mismo valor que usa Render).
 * El turno lleva la nota TEST_SHIFT_MARKER para poder localizarlo y borrarlo
 * sin tocar ningún turno real.
 */

import { MongoClient, ObjectId } from "mongodb";

const TEST_SHIFT_MARKER = "PIKI_TEST_SHIFT";
const TIME_ZONE = "Europe/Madrid";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const email = String(arg("email", "") || "").trim().toLowerCase();
const minutesAhead = Number(arg("in", "10"));
const durationMinutes = Math.max(30, Number(arg("duration", "120")));
const apply = Boolean(arg("apply", false));
const clean = Boolean(arg("clean", false));

if (!email || !email.includes("@")) {
  console.error("Falta --email del Rider. Ejemplo: --email rider@ejemplo.com");
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error("Falta MONGODB_URI en el entorno.");
  process.exit(1);
}
if (!Number.isFinite(minutesAhead) || minutesAhead < 1 || minutesAhead > 720) {
  console.error("--in debe estar entre 1 y 720 minutos.");
  process.exit(1);
}

function madridNow() {
  const values = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date())) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour), minute: Number(values.minute) };
}

function hhmm(totalMinutes) {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

const now = madridNow();
const startTotal = now.hour * 60 + now.minute + minutesAhead;
const startTime = hhmm(startTotal);
const endTime = hhmm(startTotal + durationMinutes);

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
await client.connect();
const db = client.db();

const rider = await db.collection("riders").findOne({ email });
if (!rider) {
  console.error(`No existe ningún Rider con el correo ${email}`);
  await client.close();
  process.exit(1);
}

const zoneSlug = String(rider.zoneSlugs?.[0] || rider.zoneSlug || "xativa");
const filter = { riderId: rider._id, notes: TEST_SHIFT_MARKER };

if (clean) {
  const existing = await db.collection("rider_slots").find(filter).toArray();
  for (const slot of existing) console.log(`a borrar: ${slot.date} ${slot.startTime}-${slot.endTime} (${slot._id})`);
  if (!apply) {
    console.log(`\nSimulación: se borrarían ${existing.length} turno(s) de prueba. Añade --apply.`);
    await client.close();
    process.exit(0);
  }
  const result = await db.collection("rider_slots").deleteMany(filter);
  console.log(`Borrados ${result.deletedCount} turno(s) de prueba.`);
  await client.close();
  process.exit(0);
}

const slot = {
  tenantId: rider.tenantId ?? null,
  riderId: rider._id,
  zoneSlug,
  date: now.date,
  startTime,
  endTime,
  status: "planned",
  notes: TEST_SHIFT_MARKER,
  stoppedAt: null,
  stoppedReason: "",
  createdAt: new Date(),
  updatedAt: new Date(),
};

console.log(JSON.stringify({
  rider: { id: String(rider._id), name: rider.name ?? null, email: rider.email, zoneSlug },
  slot: { ...slot, riderId: String(slot.riderId), tenantId: slot.tenantId ? String(slot.tenantId) : null },
}, null, 2));

if (!apply) {
  console.log("\nSimulación: no se ha escrito nada. Repite con --apply para crear el turno.");
  await client.close();
  process.exit(0);
}

const inserted = await db.collection("rider_slots").insertOne(slot);
console.log(`\nTurno de prueba creado: ${inserted.insertedId}`);
console.log(`Empieza a las ${startTime} (Madrid). El worker lo detectará en la ventana de 5 minutos.`);
console.log(`Para borrarlo: node scripts/seed-test-shift.mjs --email ${email} --clean --apply`);
await client.close();
