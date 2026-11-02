/**
 * Barrido automático de garantías.
 *
 * Corre dentro de la API cada cuarto de hora. Es lo que hace que la norma se
 * cumpla sola: si el rider no confirma el cobro, si el pedido se cancela o si
 * el banco suelta la autorización antes de tiempo, la retención se concilia sin
 * que nadie abra un panel. En un go-live esto es la diferencia entre una
 * contabilidad cuadrada y un montón de garantías que nadie sabe explicar.
 */
import mongoose from "mongoose";
import { CodHold } from "./codHolds.js";
import { CodHoldSweepRun, runCodHoldSweep, type CodHoldSweepReport } from "./codHoldSweep.js";

/** Cada cuánto se revisan las retenciones vivas. */
export const DEFAULT_COD_HOLD_SWEEP_INTERVAL_MS = 15 * 60_000;
/** Margen tras arrancar para no competir con las migraciones de índices. */
export const COD_HOLD_SWEEP_START_DELAY_MS = 90_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastReport: CodHoldSweepReport | null = null;
let lastError: string | null = null;
let runs = 0;
let announcedFirstRun = false;

export function codHoldSweepWorkerStatus() {
  return {
    enabled: timer !== null,
    running,
    runs,
    lastError,
    intervalMs: Number(process.env.PIKI_COD_SWEEP_INTERVAL_MS || DEFAULT_COD_HOLD_SWEEP_INTERVAL_MS),
    lastRunAt: lastReport?.finishedAt ?? null,
    lastReleased: lastReport?.released ?? 0,
    lastExpired: lastReport?.expired ?? 0,
    lastReleasedCents: lastReport?.releasedCents ?? 0,
    lastInspected: lastReport?.inspected ?? 0,
    lastErrors: lastReport?.errors.slice(0, 5) ?? [],
  };
}

/** Una sola pasada; si ya hay una en curso no se solapan. */
export async function runCodHoldSweepOnce(): Promise<CodHoldSweepReport | null> {
  if (running) return null;
  if (mongoose.connection.readyState !== 1) return null;
  running = true;
  try {
    const report = await runCodHoldSweep({ apply: true, source: "worker" });
    lastReport = report;
    lastError = null;
    runs += 1;
    // La primera pasada se anuncia siempre: es la prueba de que el barrido ha
    // arrancado y de con cuánto dinero se encontró al desplegar.
    if (!announcedFirstRun) {
      announcedFirstRun = true;
      console.log(
        JSON.stringify({
          event: "cod_hold_sweep_first_run",
          inspected: report.inspected,
          released: report.released,
          expired: report.expired,
          captured: report.captured,
          needsReview: report.needsReview,
          orphans: report.orphans,
          activeHolds: report.liability.activeHolds,
          activeCents: report.liability.activeCents,
          errors: report.errors.slice(0, 3),
        }),
      );
    }
    if (report.released || report.expired || report.captured || report.errors.length) {
      console.log(
        JSON.stringify({
          event: "cod_hold_sweep_applied",
          inspected: report.inspected,
          released: report.released,
          releasedCents: report.releasedCents,
          expired: report.expired,
          captured: report.captured,
          needsReview: report.needsReview,
          orphans: report.orphans,
          errors: report.errors,
        }),
      );
    }
    return report;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "cod_hold_sweep_failed", error: lastError }));
    return null;
  } finally {
    running = false;
  }
}

export function startCodHoldSweepWorker(): void {
  if (timer) return;
  if (String(process.env.PIKI_COD_SWEEP_ENABLED || "1") === "0") {
    console.log(JSON.stringify({ event: "cod_hold_sweep_disabled" }));
    return;
  }
  const intervalMs = Math.max(60_000, Number(process.env.PIKI_COD_SWEEP_INTERVAL_MS || DEFAULT_COD_HOLD_SWEEP_INTERVAL_MS));
  // Los índices del barrido se crean aquí: sin ellos la consulta por caducidad
  // acaba haciendo un recorrido completo en cuanto haya histórico.
  void Promise.all([CodHold.syncIndexes(), CodHoldSweepRun.syncIndexes()]).catch((error) =>
    console.warn(
      "No se pudieron sincronizar los índices del barrido de garantías",
      error instanceof Error ? error.message : String(error),
    ),
  );
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      void runCodHoldSweepOnce().finally(() => schedule(intervalMs));
    }, delay);
    timer.unref?.();
  };
  schedule(COD_HOLD_SWEEP_START_DELAY_MS);
  console.log(JSON.stringify({ event: "cod_hold_sweep_worker_started", intervalMs }));
}

export function stopCodHoldSweepWorker(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
