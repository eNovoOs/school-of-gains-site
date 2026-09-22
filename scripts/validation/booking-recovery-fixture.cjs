const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {processOne}=require('../../lib/booking-recovery');
const {normalize}=require('../../lib/ghl-signal');
const CALENDAR='test-calendar',LOCATION='3mi3YQaZvtUMZzaQUuL6';
module.exports=async function validateRecovery(db){
 process.env.GHL_CALENDAR_IDS=CALENDAR;delete process.env.ATTRIBUTION_PILOT_EMAILS;
 async function fixture(){
  const contact=randomUUID(),cycle=randomUUID(),app=randomUUID(),journey=randomUUID(),intent=randomUUID(),appointment='appointment-'+randomUUID(),ghl='contact-'+randomUUID();
  const attr={firstTouch:{source:'meetup'},latestTouch:{source:'youtube',utm_campaign:'original'}};
  await db.query('INSERT INTO sog_journeys(id,first_touch,latest_touch) VALUES($1,$2,$3)',[journey,attr.firstTouch,attr.latestTouch]);
  await db.query('INSERT INTO sog_contacts(id,email,ghl_contact_id,first_touch,latest_touch) VALUES($1,$2,$3,$4,$5)',[contact,contact+'@example.invalid',ghl,attr.firstTouch,{source:'later-unrelated'}]);
  await db.query("INSERT INTO sog_sales_cycles(id,contact_id,status,stage) VALUES($1,$2,'open','unbooked')",[cycle,contact]);
  await db.query("INSERT INTO sog_events(event_id,type,payload) VALUES($1,'quiz_submitted','{}')",[app]);
  await db.query("INSERT INTO sog_applications(id,contact_id,journey_id,cycle_id,quiz_version,answers,consent,attribution) VALUES($1,$2,$3,$4,'test','{}','{}',$5)",[app,contact,journey,cycle,attr]);
  await db.query("INSERT INTO sog_booking_intents(id,application_id,cycle_id,start_time,timezone,state,calendar_id,created_at) VALUES($1,$2,$3,now()+interval '1 day','UTC','uncertain',$4,now()-interval '3 minutes')",[intent,app,cycle,CALENDAR]);
  return {contact,cycle,app,intent,attr,event:{id:appointment,contactId:ghl,locationId:LOCATION,calendarId:CALENDAR,description:'School of Gains booking reference '+intent,appointmentStatus:'confirmed',startTime:new Date(Date.now()+30*86400000).toISOString(),dateUpdated:new Date().toISOString()}};
 }
 const one=await fixture();let reads=0;
 const read=async path=>{reads++;return path.startsWith('/contacts/')?{events:[{id:one.event.id,calendarId:CALENDAR}]}:{appointment:one.event};};
 const results=await Promise.all([processOne({db,read}),processOne({db,read})]);
 assert.equal(results.reduce((n,x)=>n+x.processed,0),1);assert.equal(reads,2);
 const stored=(await db.query('SELECT * FROM sog_appointments WHERE id=$1',[one.event.id])).rows[0];
 assert.equal(new Date(stored.starts_at).toISOString(),one.event.startTime);assert.deepEqual(stored.attribution,one.attr);assert.equal(stored.cycle_id,one.cycle);
 const two=await fixture();let replaced=false;
 const losing=await processOne({db,read:async path=>{
  if(!replaced){replaced=true;await db.query('UPDATE sog_booking_intents SET recovery_claim_token=$2 WHERE id=$1',[two.intent,randomUUID()]);}
  return path.startsWith('/contacts/')?{events:[{id:two.event.id,calendarId:CALENDAR}]}:{appointment:two.event};
 }});
 assert.equal(losing.lostLease,true);assert.equal((await db.query('SELECT 1 FROM sog_appointments WHERE id=$1',[two.event.id])).rowCount,0);
 // Retire only this isolated fixture so subsequent claims use the next one.
 await db.query("UPDATE sog_booking_intents SET recovery_status='review' WHERE id=$1",[two.intent]);
 const three=await fixture();three.event.appointmentStatus='cancelled';
 const canonical=await normalize({kind:'appointment',resourceId:three.event.id,contactId:three.event.contactId},async()=>({appointment:three.event}));
 let signal;
 const recovered=await processOne({db,read:async path=>{
  if(!signal)signal=db.saveAppointment({...canonical,applicationId:three.app,attribution:three.attr});
  return path.startsWith('/contacts/')?{events:[{id:three.event.id,calendarId:CALENDAR}]}:{appointment:three.event};
 }});
 await signal;assert.equal(recovered.processed,1);
 const intent=(await db.query('SELECT state,recovery_status,start_time FROM sog_booking_intents WHERE id=$1',[three.intent])).rows[0];
 assert.equal(intent.state,'cancelled');assert.equal(intent.recovery_status,'resolved');
 assert.notEqual(new Date(intent.start_time).toISOString(),three.event.startTime);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM sog_events WHERE payload->>'appointmentId'=$1",[three.event.id])).rows[0].n,1);
 // A browser read of the earlier confirmation must not undo canonical cancellation.
 const {complete}=require('../../lib/attribution-booking');
 const oldConfirmed={...three.event,appointmentStatus:'confirmed',dateUpdated:new Date(Date.parse(three.event.dateUpdated)-1000).toISOString()};
 const context={id:three.app,ghl_contact_id:three.event.contactId,attribution:three.attr};
 for(let i=0;i<2;i++)await assert.rejects(complete(context,{bookingId:three.intent,timezone:'UTC'},oldConfirmed),{message:'appointment_changed'});
 assert.equal((await db.query('SELECT state FROM sog_booking_intents WHERE id=$1',[three.intent])).rows[0].state,'cancelled');

};
