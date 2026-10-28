/**
 * Catálogo único de algoritmos operativos versionados.
 * Cada algoritmo mantiene su implementación aislada y este índice define el contrato
 * que consume el servidor central.
 */
export {
  DISPATCH_ALGORITHM_VERSION,
  evaluateDispatchVehicleEligibility,
  LIGHT_URBAN_ROUTE_MAX_KM,
  rankDispatchCandidates,
} from "../dispatch.js";
export {
  LOW_ACTIVITY_ALGORITHM_VERSION,
  computeMobilityAdvice,
} from "../low-activity.js";
export {
  calculateSanctionDecision,
  canRiderReceiveOffers,
  defaultSanctionPolicy,
} from "../sanctions.js";
export {
  assertTransition,
  calculateEtaRange,
  transitionSchema,
  validateCoordinates,
} from "../workflow.js";
