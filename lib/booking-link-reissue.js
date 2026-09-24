const {InputError}=require('./attribution');
const db=require('./attribution-db');
const provider=require('./attribution-ghl');
const booking=require('./attribution-booking');
const {bookingPath}=require('./attribution-http');
const {assertPilotContact}=require('./intake-pilot');
const LOCATION='3mi3YQaZvtUMZzaQUuL6',CLOSERS='GxJOcIsgv7Svx90E2BZr',TTL=72*3600000;
async function reissue(input,deps={}) {
 const storage=deps.db || db,read=deps.read || provider.request;
 const email=typeof input?.email==='string'?input.email.trim().toLowerCase():'';
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254)throw new InputError('invalid_email');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId || ''))throw new InputError('invalid_request_id');
 if(!process.env.HANDOFF_SECRET || process.env.HANDOFF_SECRET.length<32)throw new InputError('handoff_unavailable',503);
 assertPilotContact(email);
 if(!(deps.config || booking.config)().enabled)throw new InputError('booking_unavailable',503);
 const {rows:[context]}=await storage.query("SELECT a.id,a.contact_id,a.cycle_id,c.email,c.ghl_contact_id,sc.status AS cycle_status,sc.stage AS cycle_stage,sc.ghl_opportunity_id,o.status AS crm_status FROM sog_applications a JOIN sog_contacts c ON c.id=a.contact_id JOIN sog_sales_cycles sc ON sc.id=a.cycle_id LEFT JOIN sog_outbox o ON o.event_id=a.id WHERE c.email=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 1",[email]);
 if(!context)throw new InputError('application_not_found',404);
 if(context.crm_status!=='delivered' || !context.ghl_contact_id || !context.ghl_opportunity_id)throw new InputError('contact_sync_pending',409);
 if(context.cycle_status!=='open' || !['unbooked','no_show'].includes(context.cycle_stage))throw new InputError('sales_review_required',409);
 const {contact}=await read('/contacts/'+encodeURIComponent(context.ghl_contact_id));
 if(!contact || contact.id!==context.ghl_contact_id || contact.locationId!==LOCATION || String(contact.email || '').trim().toLowerCase()!==email)throw new InputError('contact_identity_changed',409);
 const {opportunity}=await read('/opportunities/'+encodeURIComponent(context.ghl_opportunity_id));
 let stages;try{stages=JSON.parse(process.env.GHL_STAGE_IDS_JSON || '{}');}catch{throw new InputError('stage_mapping_invalid',503);}
 const eligible=[stages.unbooked,stages.no_show].filter(Boolean);
 if(!opportunity || opportunity.id!==context.ghl_opportunity_id || opportunity.contactId!==context.ghl_contact_id || opportunity.locationId!==LOCATION || opportunity.pipelineId!==CLOSERS || opportunity.status!=='open' || !eligible.includes(opportunity.pipelineStageId))throw new InputError('sales_review_required',409);
 return storage.transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['booking-link:'+input.requestId]);
  const {rows:[cycle]}=await c.query('SELECT status,stage FROM sog_sales_cycles WHERE id=$1 FOR UPDATE',[context.cycle_id]);
  if(cycle?.status!=='open' || !['unbooked','no_show'].includes(cycle.stage))throw new InputError('sales_review_required',409);
  if((await c.query("SELECT 1 FROM sog_appointments WHERE cycle_id=$1 AND status IN ('new','confirmed') LIMIT 1",[context.cycle_id])).rowCount)throw new InputError('appointment_already_exists',409);
  const {rows:[prior]}=await c.query('SELECT type,contact_id,payload FROM sog_events WHERE event_id=$1',[input.requestId]);
  if(prior && (prior.type!=='booking_link_reissued' || prior.contact_id!==context.contact_id || prior.payload.applicationId!==context.id))throw new InputError('idempotency_conflict',409);
  const expiresAt=prior?Number(prior.payload.expiresAt):Date.now()+TTL;
  if(expiresAt<=Date.now())throw new InputError('reissue_expired',409);
  const path=bookingPath(context.id,expiresAt);
  if(!prior)await c.query("INSERT INTO sog_events(event_id,type,contact_id,payload) VALUES($1,'booking_link_reissued',$2,$3)",[input.requestId,context.contact_id,{applicationId:context.id,cycleId:context.cycle_id,expiresAt,basis:'authenticated_staff'}]);
  // Never persist the capability token or include it in logs.
  return {ok:true,path,expiresAt:new Date(expiresAt).toISOString(),duplicate:!!prior};
 });
}
module.exports={reissue,TTL};
