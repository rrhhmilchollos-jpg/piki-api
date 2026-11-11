export type PendingPartnerInput = {
 name:string; cuisine:string; category:string; email:string; phone?:string; address:string; locality:string;
 deliveryFeeCents?:number; commissionRateBps:number;
};
export function pendingPartnerDraft(input:PendingPartnerInput, slug:string, actorTenantId:string) {
 if(!/^[a-f\d]{24}$/i.test(actorTenantId)) throw new Error('TENANT_CONTEXT_REQUIRED');
 const {commissionRateBps,...basic}=input;
 return {...basic,slug,tenantId:actorTenantId,draftCommissionRateBps:commissionRateBps,partnerProfile:null,
  onboardingStatus:'pending_review',isActive:false,availabilityStatus:'coming_soon'};
}
