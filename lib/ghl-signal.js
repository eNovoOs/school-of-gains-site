const {createHash,randomUUID}=require('node:crypto');
const {InputError,assert}=require('./attribution');
const db=require('./attribution-db');
const provider=require('./attribution-ghl');
const LOCATION='3mi3YQaZvtUMZzaQUuL6',CLOSERS='GxJOcIsgv7Svx90E2BZr';
const NAMESPACE=Buffer.from('0f981bad369d5965bc7d438d69f4dc2c','hex');
const id=value=>typeof value==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
function signal(input) {
 // Standard Webhook adds its configured Custom Data under customData; retain
 // flat payload compatibility for existing minimal Custom Webhook senders.
 if(input && Object.prototype.hasOwnProperty.call(input,'customData')) {
  const custom=input.customData;
  assert(custom && typeof custom==='object' && !Array.isArray(custom),'invalid_custom_data');
  for(const key of ['locationId','kind','resourceId','workflowKey','contactId']) {
   if(input[key]!==undefined && custom[key]!==undefined)assert(input[key]===custom[key],'conflicting_signal_fields');
  }
  if(input.location?.id!==undefined)assert(input.location.id===custom.locationId,'conflicting_signal_location');
  if(custom.kind==='appointment' && input.calendar?.appointmentId!==undefined)assert(input.calendar.appointmentId===custom.resourceId,'conflicting_signal_resource');
  input=custom;
 }
 assert(input && input.locationId===LOCATION,'invalid_location');
 assert(['appointment','opportunity'].includes(input.kind),'invalid_signal_kind');
 assert(id(input.resourceId),'invalid_resource_id');
 assert(input.contactId===undefined || input.contactId==='' || id(input.contactId),'invalid_contact_id');
 assert(input.workflowKey===input.kind+'-state-v1','invalid_workflow_key');
 // Deliberately ignore sender status, timestamp, attribution, owner and setter.
 return {kind:input.kind,resourceId:input.resourceId,contactId:input.contactId || null,workflowKey:input.workflowKey};
}
function revision(value,allowFuture=false) {
 if(typeof value!=='string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new InputError('provider_revision_missing',503);
 const date=new Date(value);if(!allowFuture && date.getTime()>Date.now()+300000)throw new InputError('provider_revision_invalid',503);return date.toISOString();
}
function eventId(payload) {
 // RFC4122 UUIDv5 over a fixed namespace and canonical server-owned projection.
 const hash=createHash('sha1').update(NAMESPACE).update(JSON.stringify(payload)).digest().subarray(0,16);
 hash[6]=(hash[6]&15)|80;hash[8]=(hash[8]&63)|128;const h=hash.toString('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function normalize(input,read=provider.request) {
 if(input.kind==='appointment') {
  const response=await read('/calendars/events/appointments/'+encodeURIComponent(input.resourceId));
  const event=response.appointment || response.event;
  if(!event || event.id!==input.resourceId || event.locationId!==LOCATION || !id(event.contactId) || !id(event.calendarId) || (input.contactId && event.contactId!==input.contactId))throw new InputError('provider_identity_mismatch',422);
  if(!(process.env.GHL_CALENDAR_IDS || '').split(',').map(x=>x.trim()).includes(event.calendarId))throw new InputError('calendar_not_allowed',403);
  const statuses={new:'new',confirmed:'confirmed',cancelled:'cancelled',showed:'showed',noshow:'noshow','no-show':'noshow',no_show:'noshow',invalid:'invalid'};
  const status=statuses[event.appointmentStatus];if(!status)throw new InputError('provider_status_unsupported',422);
  const payload={locationId:LOCATION,appointmentId:event.id,contactId:event.contactId,calendarId:event.calendarId,status,startsAt:revision(event.startTime,true),updatedAt:revision(event.dateUpdated || event.updatedAt)};
  // Appointment start can be in the future; validate separately from update time.
  return {eventId:eventId({kind:'appointment',...payload}),...payload,bookingSetterId:null,observedVia:'provider_readback'};
 }
 const {opportunity}=await read('/opportunities/'+encodeURIComponent(input.resourceId));
 if(!opportunity || opportunity.id!==input.resourceId || opportunity.locationId!==LOCATION || opportunity.pipelineId!==CLOSERS || !id(opportunity.pipelineStageId) || (input.contactId && opportunity.contactId!==input.contactId))throw new InputError('provider_identity_mismatch',422);
 if(!['open','won','lost'].includes(opportunity.status))throw new InputError('provider_status_unsupported',422);
 const payload={type:'opportunity_updated',locationId:LOCATION,pipelineId:CLOSERS,opportunityId:opportunity.id,pipelineStageId:opportunity.pipelineStageId,status:opportunity.status,updatedAt:revision(opportunity.updatedAt || opportunity.dateUpdated)};
 return {eventId:eventId(payload),...payload,observedVia:'provider_readback'};
}
async function enqueue(input) {
 const receiptId=randomUUID();
 await db.query('INSERT INTO sog_provider_signals(id,kind,resource_id,contact_id,workflow_key) VALUES($1,$2,$3,$4,$5)',[receiptId,input.kind,input.resourceId,input.contactId,input.workflowKey]);
 return {receiptId,accepted:true};
}
async function processOne(deps={}) {
 const storage=deps.db || db,read=deps.read || provider.request;
 const job=await storage.transaction(async c=>{
  const {rows:[row]}=await c.query("SELECT * FROM sog_provider_signals WHERE status='pending' AND available_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
  if(!row)return null;
  if(row.attempts>=10){await c.query("UPDATE sog_provider_signals SET status='failed',last_error='signal_retry_exhausted',lease_until=NULL,claim_token=NULL WHERE id=$1",[row.id]);return {exhausted:true};}
  const claimToken=randomUUID();
  await c.query("UPDATE sog_provider_signals SET claim_token=$2,lease_until=now()+interval '90 seconds',attempts=attempts+1 WHERE id=$1",[row.id,claimToken]);
  return {...row,claimToken,attempts:row.attempts+1};
 });
 if(!job)return {processed:0};
 if(job.exhausted)return {processed:0,needsReview:true};
 // Lease claim commits before provider or persistence work; never hold a pool
 // connection while saveAppointment/saveOpportunity starts its transaction.
 try {
   const payload=await normalize({kind:job.kind,resourceId:job.resource_id,contactId:job.contact_id},read);
   if(job.kind==='appointment') {
    const {rows:[prior]}=await storage.query('SELECT a.status,a.starts_at,a.updated_at,c.ghl_contact_id FROM sog_appointments a JOIN sog_contacts c ON c.id=a.contact_id WHERE a.id=$1',[payload.appointmentId]);
    if(prior && prior.ghl_contact_id!==payload.contactId)throw new InputError('provider_contact_changed',422);
    if(prior && Date.parse(prior.updated_at)===Date.parse(payload.updatedAt) && (prior.status!==payload.status || Date.parse(prior.starts_at)!==Date.parse(payload.startsAt)))throw new InputError('provider_revision_collision',409);
    await storage.saveAppointment(payload);
   }else {
    const {rows:[prior]}=await storage.query('SELECT status,stage,provider_updated_at FROM sog_sales_cycles WHERE ghl_opportunity_id=$1',[payload.opportunityId]);
    let mapping;try{mapping=JSON.parse(process.env.GHL_STAGE_IDS_JSON || '{}');}catch{throw new InputError('stage_mapping_invalid',503);}
    const stage=require('./pipeline-routing').lifecycleStage(mapping,payload.pipelineStageId);
    if(prior && Date.parse(prior.provider_updated_at)===Date.parse(payload.updatedAt) && (prior.status!==payload.status || (stage && prior.stage!==stage)))throw new InputError('provider_revision_collision',409);
    await storage.saveOpportunity(payload);
   }
   const delivered=await storage.query("UPDATE sog_provider_signals SET status='delivered',normalized_event_id=$2,last_error=NULL,processed_at=now(),lease_until=NULL,claim_token=NULL WHERE id=$1 AND claim_token=$3",[job.id,payload.eventId,job.claimToken]);
   if(delivered.rowCount===0)return {processed:0,lostLease:true};
   return {processed:1};
  }catch(error){
   const code=error instanceof InputError?error.message:/^ghl_http_\d{3}$/.test(error.message)?error.message:'signal_processing_failed';
   const terminal=error instanceof InputError && [400,403,422].includes(error.status);
   await storage.query("UPDATE sog_provider_signals SET status=CASE WHEN $3::boolean OR attempts>=10 THEN 'failed' ELSE 'pending' END,last_error=$2,available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,10)-1))::int),lease_until=NULL,claim_token=NULL WHERE id=$1 AND claim_token=$4",[job.id,code,terminal,job.claimToken]);
   return {processed:0,retryQueued:!terminal && job.attempts<10,needsReview:terminal || job.attempts>=10};
  }
}
module.exports={signal,revision,eventId,normalize,enqueue,processOne};
