import { madridClock, sendDailyBusinessSummary } from "./dailyBusinessSummary.js";

/**
 * Envía el extracto del día cada noche a las 23:55 (hora de Madrid).
 *
 * Comprueba cada cinco minutos en lugar de dormir hasta la hora exacta: así
 * sobrevive a reinicios del servicio sin perder el envío.
 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let lastSentLabel: string | null = null;

async function tick(): Promise<void> {
  try {
    const clock = madridClock();
    if (clock.hour !== 23 || clock.minute < 55) return;
    const { madridDayRange } = await import("./dailyBusinessSummary.js");
    const label = madridDayRange().label;
    if (lastSentLabel === label) return;
    lastSentLabel = label;
    const result = await sendDailyBusinessSummary();
    console.log("Daily summary dispatched", { label, sent: result.sent, error: result.error });
  } catch (error) {
    console.warn("Daily summary failed", error instanceof Error ? error.message : "unknown");
  }
}

export function startDailySummaryWorker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  console.log("Daily summary worker started (23:55 Europe/Madrid)");
}

export function stopDailySummaryWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
