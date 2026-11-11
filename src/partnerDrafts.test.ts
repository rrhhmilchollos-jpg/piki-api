import test from 'node:test';
import assert from 'node:assert/strict';
import {Restaurant} from './models.js';
import {pendingPartnerDraft} from './partnerDrafts.js';
const input={name:'Validation kitchen',cuisine:'Japanese',category:'Restaurant',email:'validation@piki.test',address:'Test street 5',locality:'Test locality',commissionRateBps:1800};
const tenant='6ab891dbc9ebf588e74114f2';
test('partial legal profile reproduces the original validation failure',()=>{
 const draft=new Restaurant({...input,slug:'validation-only',tenantId:tenant,onboardingStatus:'pending_review',isActive:false,partnerProfile:{commissionRateBps:1800}});
 assert.ok(draft.validateSync()?.errors['partnerProfile.taxId']);
});
test('pending basic draft validates without inventing a legal profile',()=>{
 const draft=new Restaurant(pendingPartnerDraft(input,'validation-only',tenant));
 assert.equal(draft.validateSync(),undefined);
 assert.equal(draft.toObject().partnerProfile,null);
 assert.equal(draft.get('draftCommissionRateBps'),1800);
 assert.equal(draft.isActive,false);
 assert.equal(draft.onboardingStatus,'pending_review');
 assert.equal(draft.availabilityStatus,'coming_soon');
});
test('invalid or absent tenant cannot create a pending draft',()=>{
 assert.throws(()=>pendingPartnerDraft(input,'validation-only',''),/TENANT_CONTEXT_REQUIRED/);
});
test('commission accepted for draft is persisted without legal consent',()=>{
 const draft=new Restaurant(pendingPartnerDraft({...input,commissionRateBps:0},'validation-only',tenant));
 assert.equal(draft.get('draftCommissionRateBps'),0);
 assert.equal(draft.toObject().partnerProfile,null);
});

import {AccessAuthorization,GovernanceAuditEvent} from './models.js';
test('legacy access-audit enum rejects partner_created; no live write',()=>{
 const audit=new AccessAuthorization({employeeId:'000000000000000000000001',actorEmployeeId:'000000000000000000000001',action:'partner_created',nextStatus:'pending_review',nextRole:'partner',accessLevel:'superadmin'});
 assert.ok(audit.validateSync()?.errors.action);
});
test('restaurant creation uses valid governance audit, not a role grant',()=>{
 const audit=new GovernanceAuditEvent({tenantId:tenant,actorEmployeeId:'000000000000000000000001',actorRole:'admin',action:'partner_created',targetType:'restaurant',targetId:'000000000000000000000002',before:null,after:{isActive:false,onboardingStatus:'pending_review'}});
 assert.equal(audit.validateSync(),undefined);
});
