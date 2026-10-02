export type RiderApplicationOperationalInput = {
  name: string;
  email: string;
  phone: string;
  city: string;
  availability: string;
  vehicle: string;
};

/** Whitelist only operational contact fields; never copy identity, bank or Social Security documents into the Fleet profile. */
export function buildApprovedRiderOperationalProfile(application: RiderApplicationOperationalInput) {
  return {
    name: application.name.trim(),
    email: application.email.trim().toLowerCase(),
    phone: application.phone.trim(),
    city: application.city.trim(),
    availability: application.availability.trim(),
    vehicle: application.vehicle,
  };
}
