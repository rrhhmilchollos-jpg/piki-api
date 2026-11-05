/**
 * Barrido automático de jornada.
 *
 * Corre dentro de la API cada pocos minutos. Es lo que convierte la norma en
 * algo que se cumple sola: cuando a un rider se le acaba el tramo, el sistema
 * lo deja fuera de línea, le corta la sesión y libera el pedido que llevara
 * encima, aunque nadie abra Fleet.
 */

import mongoose from "mongoose";
import { runShiftSweep, type ShiftSweepReport } from "./shiftPlans.js";
import { acquireWorkerLease, releaseWorkerLease } from "./workerLease.js";

export const DEFAULT_SHIFT_SWEEP_INTERVAL_MS = 5 * 60_000;
export const SHIFT_SWEEP_START_DELAY_MS = 45_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastReport: ShiftSweepReport | null = null;
let lastError: string | null = null;
let runs = 0;

export function shiftSweepWorkerStatus() {
  return {
    enabled: timer !== null,
    running,
    runs,
    lastError,
    lastRunAt: lastReport?.finishedAt ?? null,
    lastApplied: lastReport?.applied ?? 0,
    lastReleased: lastReport?.released ?? 0,
    lastLoggedOut: lastReport?.loggedOut ?? 0,
    lastReminders: lastReport?.reminders ?? 0,
  };
}

/** Una sola pasada; si ya hay una en curso no se solapan. */
export async function runShiftSweepOnce(): Promise<ShiftSweepReport | null> {
  if (running) return null;
  if (mongoose.connection.readyState !== 1) return null;
  running = true;
  const leaseOwner = `${process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || "api"}:${process.pid}`;
  try {
    // Render sirve varias instancias y todas arrancan el worker. Sin lease, dos
    // instancias procesaban el mismo turno y el aviso salía (y se contaba) dos
    // veces. Solo la que consigue el lease trabaja en esta pasada.
    if (!(await acquireWorkerLease("shift_sweep", 4 * 60_000, leaseOwner))) {
      console.log(JSON.stringify({ event: "shift_sweep_skipped", reason: "lease_held_by_other_instance" }));
      return null;
    }
    const report = await runShiftSweep({ apply: true, source: "worker" });
    lastReport = report;
    lastError = null;
    runs += 1;
    // One line per run so a support engineer can confirm in Render logs that
    // the sweep actually scanned shifts and whether a start reminder fired.
    console.log(
      JSON.stringify({
        event: report.applied || report.loggedOut ? "shift_sweep_applied" : "shift_sweep_run",
        run: runs,
        checked: report.checked,
        reminders: report.reminders,
        loggedOut: report.loggedOut,
        released: report.released,
        applied: report.applied,
        errors: report.errors,
      }),
    );
    return report;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "shift_sweep_failed", error: lastError }));
    return null;
  } finally {
    await releaseWorkerLease("shift_sweep", leaseOwner).catch(() => undefined);
    running = false;
  }
}

export function startShiftSweepWorker(): void {
  if (timer) return;
  if (String(process.env.PIKI_SHIFT_SWEEP_ENABLED || "1") === "0") {
    console.log(JSON.stringify({ event: "shift_sweep_disabled" }));
    return;
  }
  const intervalMs = Math.max(60_000, Number(process.env.PIKI_SHIFT_SWEEP_INTERVAL_MS || DEFAULT_SHIFT_SWEEP_INTERVAL_MS));
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      void runShiftSweepOnce().finally(() => schedule(intervalMs));
    }, delay);
    timer.unref?.();
  };
  schedule(SHIFT_SWEEP_START_DELAY_MS);
  console.log(JSON.stringify({ event: "shift_sweep_worker_started", intervalMs }));
}

export function stopShiftSweepWorker(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
