const test=require('node:test'),assert=require('node:assert/strict');
const {findAppointment,processOne}=require('../lib/booking-recovery');
const {randomUUID}=require('node:crypto');
const calendar='kQHIe9WY8PjSAl11jSjc';process.env.GHL_CALENDAR_IDS=calendar;
const job={id:randomUUID(),application_id:'application',cycle_id:'cycle',calendar_id:calendar,ghl_contact_id:'contact',recovery_attempts:0,state:'uncertain'};
const event={id:'appointment',contactId:'contact',calendarId:calendar,locationId:'3mi3YQaZvtUMZzaQUuL6',description:'School of Gains booking reference '+job.id,appointmentStatus:'confirmed',startTime:'2027-06-01T12:00:00Z',dateUpdated:'2026-01-01T12:00:00Z'};
test('recovery follows exact reference across reschedules without any provider mutation',async()=>{
 const calls=[];const payload=await findAppointment(job,async(...args)=>{assert.equal(args.length,1);calls.push(args[0]);return args[0].startsWith('/contacts/')?{events:[{id:event.id,calendarId:calendar,startTime:'2030-01-01'}]}:{appointment:event};});
 assert.equal(payload.startsAt,'2027-06-01T12:00:00.000Z');assert.equal(calls.length,2);
});
test('known ID still requires exact reference and strict identity; malformed revisions need review',async()=>{
 for(const patch of [{description:'legacy booking'},{contactId:'other'},{calendarId:'other'},{dateUpdated:undefined}])await assert.rejects(findAppointment({...job,appointment_id:event.id},async()=>({appointment:{...event,...patch}})),e=>e.status===422);
});
test('candidate cap, incomplete list and absent calendar fail to review instead of guessing',async()=>{
 await assert.rejects(findAppointment(job,async()=>({events:Array.from({length:5},(_,i)=>({id:'appointment'+i,calendarId:calendar}))})),/recovery_candidate_review/);
 await assert.rejects(findAppointment(job,async()=>({events:[],nextPage:2})),/recovery_list_incomplete/);
 await assert.rejects(findAppointment({...job,calendar_id:null},async()=>assert.fail('must not read')),/recovery_identity_missing/);
});
function storage({lost=false}={}){
 const writes=[],saved=[];const query=async(sql,args)=>{
  writes.push({sql,args});if(sql.startsWith('SELECT * FROM sog_booking_intents WHERE state'))return {rows:[job]};
  if(sql.startsWith('SELECT a.contact_id'))return {rows:[{contact_id:'local',cycle_id:'cycle',ghl_contact_id:'contact',attribution:{latestTouch:{source:'original'}}}]};
  if(sql.startsWith('SELECT * FROM sog_booking_intents WHERE id'))return {rows:lost?[]:[job]};return {rows:[],rowCount:1};
 };return {writes,saved,db:{query,transaction:fn=>fn({query}),saveAppointmentInTransaction:async(c,payload)=>saved.push(payload)}};
}
test('claim fence prevents expired worker from persisting canonical appointment',async()=>{
 const s=storage({lost:true});const result=await processOne({db:s.db,read:async path=>path.startsWith('/contacts/')?{events:[{id:event.id,calendarId:calendar}]}:{appointment:event}});
 assert.equal(result.lostLease,true);assert.equal(s.saved.length,0);assert.ok(!s.writes.some(x=>x.sql.startsWith('UPDATE sog_appointments')));
});
test('cancelled recovery preserves original application attribution and releases intent, missed remains locked',async()=>{
 for(const status of ['cancelled','invalid','noshow','showed']){
  const s=storage();const result=await processOne({db:s.db,read:async path=>path.startsWith('/contacts/')?{events:[{id:event.id,calendarId:calendar}]}:{appointment:{...event,appointmentStatus:status}}});
  assert.equal(result.processed,1);assert.equal(s.saved[0].applicationId,job.application_id);assert.equal(s.saved[0].attribution.latestTouch.source,'original');
  assert.equal(s.writes.find(x=>x.sql.startsWith('UPDATE sog_booking_intents SET appointment_id')).args[2],['cancelled','invalid'].includes(status)?'cancelled':'confirmed');
 }
});
test('missing provider match schedules bounded read retry without marking intent failed/unlocking',async()=>{
 const s=storage();const result=await processOne({db:s.db,read:async()=>({events:[]})});assert.equal(result.retryQueued,true);
 assert.equal(s.writes.at(-1).args[1],'recovery_not_found');assert.ok(!s.writes.at(-1).sql.includes("state='failed'"));
});
test('recovery endpoint authenticates and remains disabled without explicit flag',async()=>{
 const previous={...process.env};process.env.CRON_SECRET='x'.repeat(40);process.env.GHL_SYNC_ENABLED='true';delete process.env.GHL_BOOKING_RECOVERY_ENABLED;
 try{const handler=require('../api/webhooks/recover-bookings');let status;await handler({method:'GET',headers:{authorization:'Bearer '+process.env.CRON_SECRET}},{setHeader(){},status(n){status=n;return this},json(){}});assert.equal(status,503);}finally{for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});

test('pilot restriction prevents recovery provider reads for contacts outside allowlist',async()=>{
 const old=process.env.ATTRIBUTION_PILOT_EMAILS;process.env.ATTRIBUTION_PILOT_EMAILS='only@example.com';const s=storage();
 try{const result=await processOne({db:s.db,read:async()=>assert.fail('must not read provider')});assert.equal(result.needsReview,true);assert.equal(s.writes.at(-1).args[1],'recovery_pilot_restricted');}finally{old===undefined?delete process.env.ATTRIBUTION_PILOT_EMAILS:process.env.ATTRIBUTION_PILOT_EMAILS=old;}
});

test('two matching provider appointments require review and never choose arbitrarily',async()=>{
 await assert.rejects(findAppointment(job,async path=>path.startsWith('/contacts/')?{events:[{id:'one',calendarId:calendar},{id:'two',calendarId:calendar}]}:{appointment:{...event,id:path.endsWith('/one')?'one':'two'}}),/recovery_multiple_matches/);
 await assert.rejects(findAppointment(job,async()=>({events:[{}]})),/recovery_list_incomplete/);
});
