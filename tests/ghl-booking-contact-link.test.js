const test=require('node:test');
const assert=require('node:assert/strict');
const {ensureAppointmentContact}=require('../lib/ghl-signal');
const LOCATION='3mi3YQaZvtUMZzaQUuL6';
const payload={contactId:'native-contact'};
const remote={id:payload.contactId,locationId:LOCATION,email:' Native@Example.Invalid '};
function fixture(existing){
 let canonical=existing&&{...existing};const calls=[];
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT id,email'))return {rows:canonical?.ghl_contact_id===params[0]?[canonical]:[]};
  if(sql.startsWith('SELECT * FROM sog_contacts WHERE ghl_contact_id'))return {rows:canonical?.ghl_contact_id===params[0]?[canonical]:[]};
  if(sql.startsWith('SELECT * FROM sog_contacts WHERE email'))return {rows:canonical?.email===params[0]?[canonical]:[]};
  if(sql.startsWith('INSERT INTO sog_contacts')&&!canonical)canonical={id:params[0],email:params[1],first_touch:params[2],latest_touch:params[3]};
  if(sql.startsWith('UPDATE sog_contacts'))canonical.ghl_contact_id=params[1];
  return {rows:[]};
 };
 return {db:{query,transaction:fn=>fn({query})},calls,get contact(){return canonical;}};
}
test('native booking can bind a new canonical contact using only verified GHL identity and unknown attribution',async()=>{
 const store=fixture(),reads=[];
 await ensureAppointmentContact(payload,store.db,async path=>{reads.push(path);return {contact:remote};},{});
 assert.deepEqual(reads,['/contacts/native-contact']);assert.equal(store.contact.email,'native@example.invalid');assert.equal(store.contact.ghl_contact_id,'native-contact');
 assert.equal(store.contact.first_touch.source,'unknown');assert.equal(store.contact.latest_touch.source,'unknown');
 assert.equal(store.calls.some(x=>/sog_(applications|lead_captures|sales_cycles|outbox)/.test(x.sql)),false);
 assert.equal(Object.hasOwn(store.contact,'consent'),false);
});
test('native booking reuses an email-matched browser contact and preserves its existing attribution',async()=>{
 const first={source:'meetup',medium:'offline'},latest={source:'instagram',medium:'organic_social'};
 const store=fixture({id:'browser-contact',email:'native@example.invalid',first_touch:first,latest_touch:latest});
 const linked=await ensureAppointmentContact(payload,store.db,async()=>({contact:{...remote,attributionSource:{utmSource:'different'}}}),{});
 assert.equal(linked.id,'browser-contact');assert.deepEqual(store.contact.first_touch,first);assert.deepEqual(store.contact.latest_touch,latest);
 assert.ok(store.calls.some(x=>x.sql.includes('pg_advisory_xact_lock')&&x.params[0]==='native@example.invalid'));
});
test('native first/latest attribution is captured without copying manually assigned contact source',async()=>{
 const store=fixture();
 await ensureAppointmentContact(payload,store.db,async()=>({contact:{...remote,source:'Jason',attributionSource:{utmSource:'youtube',utmMedium:'paid_video'},lastAttributionSource:{utmSource:'google',utmMedium:'cpc'}}}),{});
 assert.equal(store.contact.first_touch.source,'youtube');assert.equal(store.contact.latest_touch.source,'google');assert.equal(store.contact.first_touch.attribution_origin,'ghl_native');
});
test('conflicting linked email, foreign identity, missing email and non-pilot contact stop canonical linking',async()=>{
 const conflict=fixture({id:'browser-contact',email:'native@example.invalid',ghl_contact_id:'other-ghl-contact'});
 await assert.rejects(ensureAppointmentContact(payload,conflict.db,async()=>({contact:remote}),{}),{message:'provider_contact_identity_conflict'});
 assert.equal(conflict.calls.some(x=>x.sql.startsWith('UPDATE')),false);
 for(const change of [{id:'wrong'},{locationId:'other'},{email:''}]){
  const store=fixture();await assert.rejects(ensureAppointmentContact(payload,store.db,async()=>({contact:{...remote,...change}}),{}));
  assert.equal(store.calls.some(x=>x.sql.startsWith('INSERT')),false);
 }
 const pilot=fixture();await assert.rejects(ensureAppointmentContact(payload,pilot.db,async()=>({contact:remote}),{ATTRIBUTION_PILOT_EMAILS:'media@revupcmo.com'}));assert.equal(pilot.calls.some(x=>x.sql.startsWith('INSERT')),false);
});
test('already linked appointment contact does not create or overwrite a second canonical record',async()=>{
 const store=fixture({id:'canonical',email:'native@example.invalid',ghl_contact_id:'native-contact',first_touch:{source:'meetup'}});
 const result=await ensureAppointmentContact(payload,store.db,async()=>{throw new Error('unexpected read');},{});
 assert.equal(result.id,'canonical');assert.equal(store.calls.length,1);
});

test('already-linked contacts outside pilot allowlist cannot reach booking persistence',async()=>{
 const store=fixture({id:'canonical',email:'native@example.invalid',ghl_contact_id:'native-contact'});
 await assert.rejects(ensureAppointmentContact(payload,store.db,async()=>{throw new Error('unexpected read');},{ATTRIBUTION_PILOT_EMAILS:'media@revupcmo.com'}),{message:'intake_unavailable'});
 assert.equal(store.calls.length,1);
});
