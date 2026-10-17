const OPERATIONAL_ADDRESS = "Calle Sor Isabel de Villena 88, bajo, Novetlè, Valencia";
const OPERATIONAL_LOCATION = { type: "Point", coordinates: [-0.5468067, 38.9817572] } as const;

export function configuredPartnerRestaurantUpsert(tenantId: unknown, email: string, slug: string) {
  return {
    $set: {
      tenantId: tenantId || null,
      email,
      onboardingStatus: "approved",
      isActive: true,
      internalDemo: slug !== "kfc-xativa-qa",
      locality: "Novetlè",
      location: OPERATIONAL_LOCATION,
    },
    $setOnInsert: {
      slug,
      name: "KFC XATIVA QA",
      cuisine: "Americana",
      category: "Americana",
      partnerGroupKey: "xativa",
      tagline: "Entorno QA interno de PIKI · sin afiliación comercial.",
      phone: "",
      address: OPERATIONAL_ADDRESS,
    },
  };
}
