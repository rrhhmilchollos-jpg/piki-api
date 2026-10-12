export type RiderSupportTicketScopeInput = {
  tenantId?: unknown;
  riderId: string;
  reporterEmail: string;
  ticketId?: unknown;
};

export function buildLegacyRiderSupportTicketFilter({
  riderId,
  reporterEmail,
  ticketId,
}: RiderSupportTicketScopeInput): Record<string, unknown> {
  return {
    ...(ticketId !== undefined ? { _id: ticketId } : {}),
    tenantId: null,
    reporterEmail,
    sourceSurface: "rider",
    actions: {
      $elemMatch: {
        action: "rider_ticket_created",
        "metadata.riderId": String(riderId),
      },
    },
  };
}

export function buildRiderSupportTicketFilter({
  tenantId,
  riderId,
  reporterEmail,
  ticketId,
}: RiderSupportTicketScopeInput): Record<string, unknown> {
  const baseFilter: Record<string, unknown> = {
    ...(ticketId !== undefined ? { _id: ticketId } : {}),
    reporterEmail,
  };

  if (tenantId === undefined || tenantId === null) return baseFilter;

  return {
    ...baseFilter,
    $or: [
      { tenantId },
      buildLegacyRiderSupportTicketFilter({ riderId, reporterEmail, ticketId }),
    ],
  };
}
