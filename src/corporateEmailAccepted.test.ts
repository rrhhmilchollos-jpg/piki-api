import test from 'node:test';
import assert from 'node:assert/strict';
import { corporateRecipientAccepted } from './corporateEmail.js';

test('SMTP accepted string preserves case-insensitive target matching',()=>{
 assert.equal(corporateRecipientAccepted(['Partner@PIKI.test'],'partner@piki.test'),true);
});
test('SMTP accepted Address uses email address, not display name',()=>{
 assert.equal(corporateRecipientAccepted([{name:'Kitchen',address:'partner@piki.test'}],'partner@piki.test'),true);
});
test('SMTP other recipient does not confirm requested recipient',()=>{
 assert.equal(corporateRecipientAccepted([{address:'other@piki.test'}],'partner@piki.test'),false);
});
test('SMTP empty accepted list is rejected',()=>{
 assert.equal(corporateRecipientAccepted([],'partner@piki.test'),false);
});
