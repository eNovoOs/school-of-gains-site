const {test}=require('node:test');const assert=require('node:assert/strict');
const {signal,normalize,eventId,processOne}=require('../lib/ghl-signal');
const LOCATION='3mi3YQaZvtUMZzaQUuL6',CALENDAR='kQHIe9WY8PjSAl11jSjc';
const appointment={id:'appointment1',locationId:LOCATION,contactId:'contact1',calendarId:CALENDAR,appointmentStatus:'confirmed',startTime:'2027-01-01T15:00:00Z',dateUpdated:'2026-01-01T10:00:00Z'};
process.env.GHL_CALENDAR_IDS=CALENDAR;
const input={kind:'appointment',resourceId:'appointment1',contactId:'contact1',workflowKey:'appointment-state-v1'};
test('signal accepts only resource identity and ignores sender timestamps/status/credit',()=>{
 const value=signal({locationId:LOCATION,...input,updatedAt:'invented',status:'won',bookingSetterId:'setter'});
 assert.deepEqual(value,input);assert.throws(()=>signal({...input,locationId:'other'}),/invalid_location/);assert.throws(()=>signal({...input,locationId:LOCATION,resourceId:'../contact'}),/invalid_resource_id/);
});
test('exact provider read produces stable UUID and no setter attribution from caller',async()=>{
 const read=async path=>{assert.equal(path,'/calendars/events/appointments/appointment1');return {event:appointment};};
 const a=await normalize(input,read),b=await normalize(input,read);assert.equal(a.eventId,b.eventId);assert.match(a.eventId,/^[0-9a-f-]{14}5/);assert.equal(a.bookingSetterId,null);assert.equal(a.startsAt,'2027-01-01T15:00:00.000Z');
 const changed=await normalize(input,async()=>({event:{...appointment,appointmentStatus:'cancelled'}}));assert.notEqual(a.eventId,changed.eventId);
});
test('missing provider revision, foreign identity and unsupported calendar fail closed',async()=>{
 await assert.rejects(normalize(input,async()=>({event:{...appointment,dateUpdated:undefined}})),/provider_revision_missing/);
 await assert.rejects(normalize(input,async()=>({event:{...appointment,locationId:'other'}})),/provider_identity_mismatch/);
 await assert.rejects(normalize(input,async()=>({event:{...appointment,calendarId:'other'}})),/calendar_not_allowed/);
});
test('opportunity canonical ID changes with actual stage/version but not repeated delivery',async()=>{
 const o={id:'opp1',locationId:LOCATION,pipelineId:'GxJOcIsgv7Svx90E2BZr',pipelineStageId:'stage1',status:'lost',updatedAt:'2026-01-01T10:00:00Z'};
 const a=await normalize({kind:'opportunity',resourceId:'opp1'},async()=>({opportunity:o}));assert.equal(a.type,'opportunity_updated');
 const b=await normalize({kind:'opportunity',resourceId:'opp1'},async()=>({opportunity:{...o,pipelineStageId:'stage2'}}));assert.notEqual(a.eventId,b.eventId);assert.equal(eventId({a:1}),eventId({a:1}));
});
function storage({saveError,prior}={}){
 const writes=[];const query=async(sql,args)=>{writes.push({sql,args});if(sql.startsWith('SELECT * FROM sog_provider_signals'))return {rows:[{id:'receipt',kind:'appointment',resource_id:'appointment1',contact_id:'contact1',attempts:0}]};if(sql.startsWith('SELECT a.status'))return {rows:prior?[prior]:[]};return {rows:[]};};const db={query,transaction:fn=>fn({query}),saveAppointment:async()=>{if(saveError)throw saveError;},saveOpportunity:async()=>{}};return {db,writes};
}
test('inbox retry persists failure without marking provider state delivered',async()=>{
 const {db,writes}=storage({saveError:new Error('private data must never be logged')});const result=await processOne({db,read:async()=>({event:appointment})});assert.equal(result.retryQueued,true);assert.ok(writes.at(-1).sql.includes('available_at'));assert.equal(writes.at(-1).args[1],'signal_processing_failed');assert.ok(!writes.some(x=>x.sql.includes("status='delivered'")));
});
test('successful processing records canonical event ID; same-version conflicting state needs review',async()=>{
 const ok=storage();assert.equal((await processOne({db:ok.db,read:async()=>({event:appointment})})).processed,1);assert.ok(ok.writes.at(-1).sql.includes('normalized_event_id'));
 const clash=storage({prior:{ghl_contact_id:'contact1',status:'cancelled',starts_at:appointment.startTime,updated_at:appointment.dateUpdated}});const r=await processOne({db:clash.db,read:async()=>({event:appointment})});assert.equal(r.retryQueued,true);assert.equal(clash.writes.at(-1).args[1],'provider_revision_collision');
});
test('worker releases claim transaction before starting canonical persistence',async()=>{
 const base=storage();let inTransaction=false;const wrapped={...base.db,transaction:async fn=>{inTransaction=true;try{return await base.db.transaction(fn);}finally{inTransaction=false;}},saveAppointment:async()=>assert.equal(inTransaction,false)};
 assert.equal((await processOne({db:wrapped,read:async()=>({event:appointment})})).processed,1);
});
test('signal HTTP ingress rejects absent credentials before storage',async()=>{
 const handler=require('../api/webhooks/ghl-signal');const old=process.env.GHL_EVENTS_SECRET;delete process.env.GHL_EVENTS_SECRET;let code;const response={setHeader(){},status(v){code=v;return this;},json(v){return v;}};
 try{await handler({method:'POST',headers:{},body:{locationId:LOCATION,...input}},response);assert.equal(code,503);}finally{old===undefined?delete process.env.GHL_EVENTS_SECRET:process.env.GHL_EVENTS_SECRET=old;}
});
test('sanitized live GET appointment envelope normalizes authoritative offset timestamps',async()=>{
 const fixture=require('./fixtures/ghl-appointment-live-shape.json');
 const result=await normalize(input,async()=>fixture);
 assert.equal(result.appointmentId,'appointment1');
 assert.equal(result.updatedAt,'2026-03-17T17:24:56.000Z');
 assert.equal(result.startsAt,'2026-03-17T20:00:00.000Z');
});
test('standard webhook customData is projected without retaining its built-in contact payload',()=>{
 const payload={location:{id:LOCATION},calendar:{appointmentId:'appointment1'},email:'private@example.invalid',notes:'discard',customData:{locationId:LOCATION,...input}};
 assert.deepEqual(signal(payload),input);
 assert.throws(()=>signal({...payload,location:{id:'other'}}),/conflicting_signal_location/);
 assert.throws(()=>signal({...payload,resourceId:'another'}),/conflicting_signal_fields/);
 assert.throws(()=>signal({...payload,calendar:{appointmentId:'another'}}),/conflicting_signal_resource/);
 assert.throws(()=>signal({...payload,customData:[]}),/invalid_custom_data/);
});
