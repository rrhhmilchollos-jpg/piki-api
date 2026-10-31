import { z } from "zod";

export const VEHICLE_TYPES = [
  "bike",
  "electric_bike",
  "electric_scooter",
  "motorcycle",
  "scooter",
  "car",
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];
export const vehicleTypeSchema = z.enum(VEHICLE_TYPES);
export const VEHICLE_CATALOG_VERSION = 1;

export const vehicleLabels: Record<VehicleType, string> = {
  bike: "Bicicleta",
  electric_bike: "Bici eléctrica",
  electric_scooter: "Patinete eléctrico",
  motorcycle: "Motocicleta",
  scooter: "Scooter",
  car: "Coche",
};

export const allVehicleTypes = [...VEHICLE_TYPES] as VehicleType[];

export function uniqueVehicles(values: readonly VehicleType[]): VehicleType[] {
  return [...new Set(values)];
}

export function incompatibleVehicles(
  selected: readonly VehicleType[],
  allowed: readonly VehicleType[],
): VehicleType[] {
  const allowedSet = new Set(allowed);
  return uniqueVehicles(selected).filter((vehicle) => !allowedSet.has(vehicle));
}
