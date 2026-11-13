export interface IndexMaintenanceModel {
  modelName?: string;
  syncIndexes(): Promise<unknown>;
  createIndexes(): Promise<unknown>;
}

export type IndexRaceReporter = (
  message: string,
  details: { model: string; code: 27; codeName: "IndexNotFound" },
) => void;

export async function syncIndexesWithIndexRaceRecovery(
  model: IndexMaintenanceModel,
  report: IndexRaceReporter = (message, details) => console.warn(message, details),
): Promise<void> {
  try {
    await model.syncIndexes();
  } catch (error) {
    const mongoError = error as { code?: unknown; codeName?: unknown };
    if (mongoError.code !== 27 && mongoError.codeName !== "IndexNotFound") throw error;

    report("Concurrent MongoDB index cleanup detected; rebuilding model indexes", {
      model: model.modelName || "unknown",
      code: 27,
      codeName: "IndexNotFound",
    });
    await model.createIndexes();
  }
}
