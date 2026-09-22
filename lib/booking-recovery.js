const {randomUUID}=require('node:crypto');
const db=require('./attribution-db');
const {request}=require('./attribution-ghl');
const {normalize}=require('./ghl-signal');
const {InputError}=require('./attribution');
const {assertPilotContact}=require('./intake-pilot');
const LOCATION='3mi3YQaZvtUMZzaQUuL6';
const MAX_ATTEMPTS=8,MAX_CANDIDATES=4;
const validId=value=>typeof value==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
function review(code){return new InputError(code,422);}
async function findAppointment(job,read=request){
 if(!validId(job.ghl_contact_id) || !validId(job.calendar_id))throw review('recovery_identity_missing');
 if(!(process.env.GHL_CALENDAR_IDS || '').split(',').map(x=>x.trim()).includes(job.calendar_id))throw review('recovery_calendar_not_allowed');
 let ids;
 if(job.appointment_id){if(!validId(job.appointment_id))throw review('recovery_identity_invalid');ids=[job.appointment_id];}
 else {
  const list=await read('/contacts/'+encodeURIComponent(job.ghl_contact_id)+'/appointments');
  if(!Array.isArray(list.events) || list.events.some(e=>!e || !validId(e.id) || !validId(e.calendarId)) || list.meta?.nextPage || list.nextPage)throw review('recovery_list_incomplete');
  // Never filter by original start time: a salesperson may have moved the call.
  const candidates=list.events.filter(e=>e.calendarId===job.calendar_id);
  if(candidates.length>MAX_CANDIDATES || candidates.some(e=>!validId(e.id)))throw review('recovery_candidate_review');
  ids=[...new Set(candidates.map(e=>e.id))];
 }
 let found;
 for(const id of ids){
  const response=await read('/calendars/events/appointments/'+encodeURIComponent(id));
  const event=response.appointment || response.event;
  if(!event || event.id!==id || event.contactId!==job.ghl_contact_id || event.calendarId!==job.calendar_id || event.locationId!==LOCATION)throw review('recovery_identity_mismatch');
  if(event.description!=='School of Gains booking reference '+job.id){if(job.appointment_id)throw review('recovery_reference_mismatch');continue;}
  if(found)throw review('recovery_multiple_matches');
  try{found=await normalize({kind:'appointment',resourceId:id,contactId:job.ghl_contact_id},async()=>response);}catch{throw review('recovery_payload_invalid');}
 }
 return found;
}
async function processOne(deps={}){
 const storage=deps.db || db,read=deps.read || request;
 const job=await storage.transaction(async c=>{
  const {rows:[intent]}=await c.query("SELECT * FROM sog_booking_intents WHERE state IN ('pending','uncertain') AND recovery_status='pending' AND created_at<now()-interval '2 minutes' AND recovery_available_at<=now() AND (recovery_lease_until IS NULL OR recovery_lease_until<=now()) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
  if(!intent)return null;
  if(intent.recovery_attempts>=MAX_ATTEMPTS){await c.query("UPDATE sog_booking_intents SET recovery_status='review',recovery_last_error='recovery_exhausted',recovery_claim_token=NULL,recovery_lease_until=NULL WHERE id=$1",[intent.id]);return {exhausted:true};}
  const claimToken=randomUUID();
  await c.query("UPDATE sog_booking_intents SET recovery_attempts=recovery_attempts+1,recovery_claim_token=$2,recovery_lease_until=now()+interval '90 seconds' WHERE id=$1",[intent.id,claimToken]);
  return {...intent,claimToken,recovery_attempts:intent.recovery_attempts+1};
 });
 if(!job)return {processed:0};if(job.exhausted)return {processed:0,needsReview:true};
 try{
  const {rows:[application]}=await storage.query('SELECT a.contact_id,a.cycle_id,a.attribution,c.email,c.ghl_contact_id FROM sog_applications a JOIN sog_contacts c ON c.id=a.contact_id WHERE a.id=$1',[job.application_id]);
  if(!application || application.cycle_id!==job.cycle_id)throw review('recovery_application_mismatch');
  try{assertPilotContact(application.email);}catch{throw review('recovery_pilot_restricted');}
  const payload=await findAppointment({...job,...application},read);
  if(!payload)throw new InputError('recovery_not_found',503);
  return await storage.transaction(async c=>{
   // Follow saveAppointment's lock order; never hold intent while acquiring contact/cycle.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[payload.appointmentId]);
   await c.query('SELECT id FROM sog_contacts WHERE id=$1 FOR UPDATE',[application.contact_id]);
   await c.query('SELECT id FROM sog_sales_cycles WHERE id=$1 FOR UPDATE',[job.cycle_id]);
   const {rows:[intent]}=await c.query('SELECT * FROM sog_booking_intents WHERE id=$1 AND recovery_claim_token=$2 AND recovery_lease_until>clock_timestamp() FOR UPDATE',[job.id,job.claimToken]);
   if(!intent)return {processed:0,lostLease:true};
   if(intent.appointment_id && intent.appointment_id!==payload.appointmentId)throw review('recovery_intent_mismatch');
   if(!['pending','uncertain','confirmed','cancelled'].includes(intent.state)){
    await c.query("UPDATE sog_booking_intents SET recovery_status='resolved',recovery_claim_token=NULL,recovery_lease_until=NULL WHERE id=$1",[job.id]);return {processed:1};
   }
   const {rows:[prior]}=await c.query('SELECT contact_id,cycle_id,updated_at,status,starts_at FROM sog_appointments WHERE id=$1',[payload.appointmentId]);
   if(prior && (prior.contact_id!==application.contact_id || prior.cycle_id!==job.cycle_id))throw review('recovery_cycle_mismatch');
   if(prior && Date.parse(prior.updated_at)>Date.parse(payload.updatedAt))throw new InputError('recovery_revision_stale',503);
   if(prior && Date.parse(prior.updated_at)===Date.parse(payload.updatedAt) && (prior.status!==payload.status || Date.parse(prior.starts_at)!==Date.parse(payload.startsAt)))throw review('recovery_revision_collision');
   await storage.saveAppointmentInTransaction(c,{...payload,applicationId:job.application_id,attribution:application.attribution});
   // An earlier signal may have observed the same appointment first. Its verified
   // booking reference establishes this application's original frozen attribution.
   await c.query('UPDATE sog_appointments SET attribution=$2 WHERE id=$1',[payload.appointmentId,application.attribution]);
   const state=['cancelled','invalid'].includes(payload.status)?'cancelled':'confirmed';
   await c.query("UPDATE sog_booking_intents SET appointment_id=$2,state=$3,recovery_status='resolved',recovery_last_error=NULL,recovery_claim_token=NULL,recovery_lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,payload.appointmentId,state]);
   return {processed:1};
  });
 }catch(error){
  const terminal=error instanceof InputError && error.status===422;
  const code=error instanceof InputError && /^recovery_[a-z_]+$/.test(error.message)?error.message:'recovery_read_failed';
  const updated=await storage.query("UPDATE sog_booking_intents SET recovery_status=CASE WHEN $3::boolean OR recovery_attempts>=8 THEN 'review' ELSE 'pending' END,recovery_last_error=$2,recovery_available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(recovery_attempts,8)-1))::int),recovery_claim_token=NULL,recovery_lease_until=NULL WHERE id=$1 AND recovery_claim_token=$4 AND recovery_lease_until>clock_timestamp()",[job.id,code,terminal,job.claimToken]);
  if(updated.rowCount===0)return {processed:0,lostLease:true};
  return {processed:0,retryQueued:!terminal && job.recovery_attempts<MAX_ATTEMPTS,needsReview:terminal || job.recovery_attempts>=MAX_ATTEMPTS};
 }
}
module.exports={findAppointment,processOne};
