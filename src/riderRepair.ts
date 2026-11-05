import { EmployeeAccount, Rider, RiderSlot } from "./models.js";

const OWNER_EMAIL = (process.env.PIKI_OWNER_EMAIL || "rrhh.milchollos@gmail.com").trim().toLowerCase();
let done = false;

function madridToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

export async function runRiderRepairOnce(): Promise<void> {
  if (done || process.env.PIKI_RIDER_REPAIR !== "1") return;
  done = true;
  try {
    const account: any = await EmployeeAccount.findOne({ email: OWNER_EMAIL }).lean().exec();
    const roles = Array.from(new Set([...(Array.isArray(account?.roles) ? account.roles : []), "admin", "rider"]));
    await EmployeeAccount.updateOne({ _id: account?._id }, { $set: { roles, primaryRole: "admin", active: true, ownerProtected: true } }).exec();

    const today = madridToday();
    const candidates: any[] = await Rider.find({ $or: [{ email: OWNER_EMAIL }, { name: /iv[aá]n/i }, { name: /rubio/i }] })
      .select("_id name email status lifecycleStatus createdAt").lean().exec();
    const withSlots = [] as any[];
    for (const rider of candidates) {
      const slots = await RiderSlot.find({ riderId: rider._id }).select("date startTime endTime status zoneSlug").lean().exec();
      withSlots.push({ id: String(rider._id), name: rider.name, email: rider.email || null, status: rider.status, life: rider.lifecycleStatus, createdAt: rider.createdAt, slots: slots.length, todaySlots: slots.filter((slot: any) => String(slot.date) === today), allSlots: slots.map((slot: any) => `${slot.date} ${slot.startTime}-${slot.endTime} ${slot.status}`) });
    }
    const canonical = withSlots.find((rider) => rider.email === OWNER_EMAIL) || withSlots.sort((a, b) => b.slots - a.slots)[0] || null;
    if (canonical) {
      await Rider.updateOne({ _id: canonical.id }, { $set: { email: OWNER_EMAIL, lifecycleStatus: "active", status: "available" } }).exec();
      for (const rider of withSlots) {
        if (rider.id === canonical.id) continue;
        await RiderSlot.updateMany({ riderId: rider.id }, { $set: { riderId: canonical.id } }).exec();
        await Rider.updateOne({ _id: rider.id }, { $set: { lifecycleStatus: "merged", status: "inactive" } }).exec();
      }
    }
    console.log("[rider-repair]", JSON.stringify({ ownerEmail: OWNER_EMAIL, roles, today, canonical: canonical?.id || null, riders: withSlots }));
  } catch (error) {
    console.error("[rider-repair] error", error instanceof Error ? error.message : error);
  }
}
