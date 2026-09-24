const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {application}=require('../../lib/attribution');
const {bookingPath}=require('../../lib/attribution-http');
const {claimFor}=require('../../lib/attribution-booking');
const {reissue,TTL}=require('../../lib/booking-link-reissue');
const {reconcileCycle}=require('../../lib/sales-tasks');
const {attest}=require('../../lib/setter-credit');
const LOCATION='3mi3YQaZvtUMZzaQUuL6',CLOSERS='GxJOcIsgv7Svx90E2BZr';
module.exports=async function validateReissueCredit(db){
 assert.match((await db.query('SELECT current_schema() AS name')).rows[0].name,/^sog_test_[0-9a-f]{32}$/);
 const saved={...process.env},originalFetch=global.fetch,checks=[];
 Object.assign(process.env,{HANDOFF_SECRET:'disposable-fixture-handoff-secret-'.repeat(2),GHL_STAGE_IDS_JSON:JSON.stringify({unbooked:'fixture-unbooked',no_show:'fixture-no-show'}),GHL_TASKS_ENABLED:'true',GHL_TASK_DUE_HOURS:'24',GHL_CALENDAR_IDS:'fixture-calendar',SETTER_CREDIT_ENABLED:'true',SETTER_CREDIT_SETTERS_JSON:JSON.stringify([{id:'setter-a',name:'Fixture Setter A'},{id:'setter-b',name:'Fixture Setter B'}])});
 delete process.env.ATTRIBUTION_PILOT_EMAILS;
 global.fetch=async()=>{throw new Error('External HTTP prohibited in disposable reissue/credit fixture');};
 try{
  const email='reissue-'+randomUUID()+'@example.invalid';
  const input=application({submissionId:randomUUID(),journeyId:randomUUID(),quizVersion:'apprentice-v1',contact:{email,firstName:'Fixture'},consent:{privacy:true,marketing:false},answers:{ageRange:'30_39',goals:['build_system'],weeklyTime:'3_5_hours',educationBudget:'not_ready',attendance:'unsure'},attribution:{utm_source:'meetup',utm_medium:'offline'}});
  await db.saveApplication(input);
  const app=(await db.query('SELECT * FROM sog_applications WHERE id=$1',[input.submissionId])).rows[0];
  const ghlContact='fixture-contact-'+randomUUID(),ghlOpportunity='fixture-opp-'+randomUUID();
  await db.query('UPDATE sog_contacts SET ghl_contact_id=$2 WHERE id=$1',[app.contact_id,ghlContact]);
  await db.query('UPDATE sog_sales_cycles SET ghl_opportunity_id=$2,assigned_closer_id=$3 WHERE id=$1',[app.cycle_id,ghlOpportunity,'fixture-closer']);
  await db.query("UPDATE sog_outbox SET status='delivered' WHERE event_id=$1",[app.id]);
  await db.transaction(c=>reconcileCycle(c,app.cycle_id));
  const task=(await db.query('SELECT * FROM sog_sales_tasks WHERE cycle_id=$1',[app.cycle_id])).rows[0];
  const taskOrigin=(await db.query('SELECT created_at FROM sog_sales_cycles WHERE id=$1',[app.cycle_id])).rows[0].created_at;
  assert.ok(task);assert.equal(new Date(task.due_at)-new Date(taskOrigin),86400000);
  const clock=Date.now;let oldPath;
  try{Date.now=()=>clock()-2*3600000;oldPath=bookingPath(app.id);}finally{Date.now=clock;}
  const token=path=>new URL(path,'https://fixture.invalid').searchParams.get('ref');
  assert.throws(()=>claimFor(token(oldPath)),{message:'handoff_expired'});
  const contact={id:ghlContact,email,locationId:LOCATION};
  const opportunity={id:ghlOpportunity,contactId:ghlContact,locationId:LOCATION,pipelineId:CLOSERS,status:'open',pipelineStageId:'fixture-unbooked'};
  const read=async path=>{
   if(path==='/contacts/'+ghlContact)return {contact};
   if(path==='/opportunities/'+ghlOpportunity)return {opportunity};
   throw new Error('unexpected_fixture_provider_path');
  };
  const request={email,requestId:randomUUID()},before=Date.now();
  const results=await Promise.all(Array.from({length:3},()=>reissue(request,{db,read,config:()=>({enabled:true})})));
  assert.equal(results.filter(result=>!result.duplicate).length,1);assert.equal(new Set(results.map(result=>result.path)).size,1);
  const claim=claimFor(token(results[0].path));assert.equal(claim.id,app.id);assert.ok(claim.expires>=before+TTL&&claim.expires<=Date.now()+TTL);assert.match(results[0].expiresAt,/Z$/);
  const audits=(await db.query('SELECT * FROM sog_events WHERE event_id=$1',[request.requestId])).rows;
  assert.equal(audits.length,1);assert.equal(audits[0].type,'booking_link_reissued');assert.equal(audits[0].payload.expiresAt,claim.expires);
  assert.equal(JSON.stringify(audits[0].payload).includes('ref='),false);
  const retry=await reissue(request,{db,read,config:()=>({enabled:true})});assert.equal(retry.path,results[0].path);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_applications WHERE contact_id=$1',[app.contact_id])).rows[0].n,1);
  const unchangedTask=(await db.query('SELECT * FROM sog_sales_tasks WHERE id=$1',[task.id])).rows[0];assert.equal(new Date(unchangedTask.due_at).toISOString(),new Date(task.due_at).toISOString());
  checks.push('expired original link is replaced by one audited72-hour capability under concurrent retry without fabricating another quiz or resetting24-hour task');

  const appointmentId='fixture-booking-'+randomUUID(),now=Date.now();
  const event={id:appointmentId,locationId:LOCATION,contactId:ghlContact,calendarId:'fixture-calendar',appointmentStatus:'confirmed',startTime:new Date(now+86400000).toISOString(),dateUpdated:new Date(now).toISOString()};
  await db.saveAppointment({eventId:randomUUID(),appointmentId,contactId:ghlContact,calendarId:event.calendarId,status:'confirmed',startsAt:event.startTime,updatedAt:event.dateUpdated,bookingSetterId:null});
  const bookingRead=async path=>path==='/calendars/events/appointments/'+appointmentId?{appointment:event}:read(path);
  const credit={appointmentId,setterId:'setter-a',requestId:randomUUID(),reason:'Fixture verifies booking setter from the sales call record.'};
  const credits=await Promise.all(Array.from({length:3},()=>attest(credit,'a'.repeat(64),{db,read:bookingRead})));
  assert.equal(credits.filter(result=>!result.duplicate).length,1);assert.ok(credits.every(result=>result.evidenceType==='admin_attested'));
  const ledger=(await db.query('SELECT * FROM sog_booking_setter_credits WHERE appointment_id=$1',[appointmentId])).rows;
  assert.equal(ledger.length,1);assert.equal(ledger[0].setter_id,'setter-a');assert.equal(ledger[0].request_id,credit.requestId);assert.equal(ledger[0].admin_session_hash,'a'.repeat(64));assert.equal(new Date(ledger[0].provider_revision).toISOString(),event.dateUpdated);
  await assert.rejects(attest({...credit,setterId:'setter-b',requestId:randomUUID()},'b'.repeat(64),{db,read:bookingRead}),{message:'credit_already_recorded'});
  await assert.rejects(attest({...credit,reason:'Conflicting reason must not silently replace prior audit.'},'a'.repeat(64),{db,read:bookingRead}),{message:'credit_request_conflict'});
  assert.equal((await db.query('SELECT booking_setter_id FROM sog_appointments WHERE id=$1',[appointmentId])).rows[0].booking_setter_id,'setter-a');
  const cycle=(await db.query('SELECT assigned_closer_id,booking_setter_id FROM sog_sales_cycles WHERE id=$1',[app.cycle_id])).rows[0];assert.equal(cycle.assigned_closer_id,'fixture-closer');assert.equal(cycle.booking_setter_id,null);
  checks.push('concurrent staff setter attestation writes one immutable credit audit, rejects conflicting credit/request and preserves closer owner');
  return checks;
 }finally{
  global.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
 }
};
