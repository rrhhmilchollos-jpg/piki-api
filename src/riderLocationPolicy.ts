import { validateCoordinates } from "./workflow.js";

export type TrackingLocationSample = {
  sampleId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  recordedAt: Date;
};

export type PreparedTrackingBatch = {
  candidates: TrackingLocationSample[];
  duplicates: string[];
  rejected: string[];
};

/**
 * Screens a client batch before any write. A repeated sample id is acknowledged
 * as a duplicate and never makes a second database attempt. Invalid or future
 * coordinates are rejected rather than becoming the Rider's latest position.
 */
export function prepareTrackingBatch(samples: readonly TrackingLocationSample[], now = new Date()): PreparedTrackingBatch {
  const seenSampleIds = new Set<string>();
  const candidates: TrackingLocationSample[] = [];
  const duplicates: string[] = [];
  const rejected: string[] = [];

  for (const sample of [...samples].sort((left, right) => left.recordedAt.getTime() - right.recordedAt.getTime())) {
    if (seenSampleIds.has(sample.sampleId)) {
      duplicates.push(sample.sampleId);
      continue;
    }
    seenSampleIds.add(sample.sampleId);
    if (
      !validateCoordinates(sample.latitude, sample.longitude)
      || !Number.isFinite(sample.accuracyMeters)
      || sample.accuracyMeters < 0
      || sample.recordedAt.getTime() > now.getTime() + 60_000
      || Number.isNaN(sample.recordedAt.getTime())
    ) {
      rejected.push(sample.sampleId);
      continue;
    }
    candidates.push(sample);
  }

  return { candidates, duplicates, rejected };
}
