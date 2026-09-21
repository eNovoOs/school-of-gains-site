const test=require('node:test');
const assert=require('node:assert/strict');
const {assertPilotContact}=require('../lib/intake-pilot');
test('restricted pilot accepts exact normalized identities and fails closed otherwise',()=>{
 const env={ATTRIBUTION_PILOT_EMAILS:' Pilot@example.com '};
 assert.doesNotThrow(()=>assertPilotContact('pilot@example.com',env));
 for(const email of ['other@example.com','pilot+other@example.com','notpilot@example.com'])assert.throws(()=>assertPilotContact(email,env),e=>e.status===503);
 assert.throws(()=>assertPilotContact('pilot@example.com',{ATTRIBUTION_PILOT_EMAILS:' , '}));
 assert.throws(()=>assertPilotContact('pilot@example.com',{ATTRIBUTION_PILOT_EMAILS:'*'}));
 assert.doesNotThrow(()=>assertPilotContact('public@example.com',{}));
});
