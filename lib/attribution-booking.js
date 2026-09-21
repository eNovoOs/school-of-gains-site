const {createHmac} = require('node:crypto');
const {InputError,secureEqual,assert} = require('./attribution');
const db = require('./attribution-db');
const {request} = require('./attribution-ghl');
const {assertPilotContact} = require('./intake-pilot');
const LOCATION='3mi3YQaZvtUMZzaQUuL6';
function claimFor(token) {
  const secret=process.env.HANDOFF_SECRET;
  if(!secret || secret.length<32) throw new InputError('handoff_unavailable',503);
  if(typeof token!=='string' || token.length>1000) throw new InputError('invalid_handoff',401);
  const [value,signature,...extra]=token.split('.');
  if(!value || !signature || extra.length || !secureEqual(signature,createHmac('sha256',secret).update(value).digest('base64url'))) throw new InputError('invalid_handoff',401);
  let claim; try {claim=JSON.parse(Buffer.from(value,'base64url').toString());} catch {throw new InputError('invalid_handoff',401);}
  if(!/^[0-9a-f-]{36}$/i.test(claim.id || '') || !Number.isFinite(claim.expires) || claim.expires<Date.now()) throw new InputError('handoff_expired',401);
  return claim;
}
async function contextFor(token) {
  const claim=claimFor(token);
  const {rows:[context]}=await db.query('SELECT a.id,a.contact_id,a.cycle_id,a.attribution,c.email,c.ghl_contact_id,sc.status AS cycle_status,sc.stage AS cycle_stage,sc.ghl_opportunity_id,o.status AS crm_status FROM sog_applications a JOIN sog_contacts c ON c.id=a.contact_id JOIN sog_sales_cycles sc ON sc.id=a.cycle_id LEFT JOIN sog_outbox o ON o.event_id=a.id WHERE a.id=$1',[claim.id]);
  if(!context) throw new InputError('application_not_found',404);
  assertPilotContact(context.email);
  return context;
}
function config() {
  const calendarId=process.env.GHL_BOOKING_CALENDAR_ID || 'kQHIe9WY8PjSAl11jSjc';
  const allowed=(process.env.GHL_CALENDAR_IDS || '').split(',');
  const enabled=process.env.GHL_BOOKING_ENABLED==='true' && process.env.GHL_SYNC_ENABLED==='true' && !!process.env.GHL_PRIVATE_INTEGRATION_TOKEN && allowed.includes(calendarId);
  return {calendarId,enabled};
}
function requireBooking(context) {
  const value=config();if(!value.enabled)throw new InputError('booking_unavailable',503);
  if(!context.ghl_contact_id || context.crm_status!=='delivered')throw new InputError('contact_sync_pending',409);
  if(context.cycle_status!=='open' || !context.ghl_opportunity_id || ['legacy_review','customer_review'].includes(context.cycle_stage))throw new InputError('sales_review_required',409);
  return value;
}
function timezone(value) {assert(typeof value==='string' && value.length<100,'invalid_timezone');try{new Intl.DateTimeFormat('en',{timeZone:value});}catch{throw new InputError('invalid_timezone');}return value;}
function range(input,now=Date.now()) {
  const start=Number(input.startDate),end=Number(input.endDate);
  assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start>=now-300000 && end>start && end-start<=31*86400000 && end<=now+90*86400000,'invalid_date_range');
  return {startDate:start,endDate:end,timezone:timezone(input.timezone)};
}
async function slots(context,input) {
  const {calendarId}=requireBooking(context);
  const result=await request('/calendars/'+encodeURIComponent(calendarId)+'/free-slots?'+new URLSearchParams(range(input)));
  const times=[];
  for(const [day,value] of Object.entries(result))if(/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(value?.slots))for(const slot of value.slots)if(typeof slot==='string' && Number.isFinite(Date.parse(slot)))times.push(new Date(slot).toISOString());
  return [...new Set(times)].sort();
}
function bookingInput(input) {
  assert(input && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.bookingId || ''),'invalid_booking_id');
  assert(typeof input.startTime==='string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(input.startTime) && Number.isFinite(Date.parse(input.startTime)),'invalid_start_time');
  const startTime=new Date(input.startTime).toISOString();
  assert(Date.parse(startTime)>Date.now() && Date.parse(startTime)<Date.now()+90*86400000,'invalid_start_time');
  return {bookingId:input.bookingId,startTime,timezone:timezone(input.timezone)};
}
function appointmentPayload(context,input) {
  const {calendarId}=requireBooking(context);
  return {locationId:LOCATION,calendarId,contactId:context.ghl_contact_id,startTime:input.startTime,title:'School of Gains Strategy & Enrollment Call',description:'School of Gains booking reference '+input.bookingId,appointmentStatus:'confirmed',ignoreDateRange:false,ignoreFreeSlotValidation:false,toNotify:process.env.GHL_BOOKING_NOTIFICATIONS_ENABLED==='true'};
}
async function verifyAppointment(id,context,input) {
  const result=await request('/calendars/events/appointments/'+encodeURIComponent(id));
  const event=result.appointment || result.event;
  if(!event || event.id!==id || event.locationId!==LOCATION || event.contactId!==context.ghl_contact_id || event.calendarId!==config().calendarId || Date.parse(event.startTime)!==Date.parse(input.startTime) || !['new','confirmed'].includes(event.appointmentStatus)) throw new InputError('booking_verification_pending',202);
  if(!Number.isFinite(Date.parse(event.dateUpdated))) throw new InputError('booking_verification_pending',202);
  return event;
}
async function reconcile(context,input) {
  const result=await request('/contacts/'+encodeURIComponent(context.ghl_contact_id)+'/appointments');
  // The live contact LIST endpoint returns naive calendar-local timestamps.
  // Use only a broad date window there, then compare exact offset-aware GET data.
  const day=Date.parse(input.startTime),low=new Date(day-86400000).toISOString().slice(0,10),high=new Date(day+86400000).toISOString().slice(0,10);
  const candidates=(result.events || []).filter(event=>event.calendarId===config().calendarId && typeof event.startTime==='string' && event.startTime.slice(0,10)>=low && event.startTime.slice(0,10)<=high);
  if(candidates.length>12)throw new InputError('booking_verification_pending',202);
  let match=null;
  for(const candidate of candidates) {
    const response=await request('/calendars/events/appointments/'+encodeURIComponent(candidate.id));
    const event=response.appointment || response.event;
    if(!event || event.id!==candidate.id || event.locationId!==LOCATION || event.contactId!==context.ghl_contact_id || event.calendarId!==config().calendarId)throw new InputError('booking_verification_pending',202);
    if(Date.parse(event.startTime)!==Date.parse(input.startTime) || !['new','confirmed'].includes(event.appointmentStatus))continue;
    if(!Number.isFinite(Date.parse(event.dateUpdated)))throw new InputError('booking_verification_pending',202);
    if(match || event.description!=='School of Gains booking reference '+input.bookingId)throw new InputError('appointment_already_exists',409);
    match=event;
  }
  return match;
}
async function complete(context,input,event) {
  // Store intent first. If later processing fails, retries GET the same provider ID.
  await db.query("UPDATE sog_booking_intents SET state='confirmed',appointment_id=$2,updated_at=now() WHERE id=$1",[input.bookingId,event.id]);
  await db.saveAppointment({eventId:input.bookingId,locationId:LOCATION,appointmentId:event.id,contactId:context.ghl_contact_id,calendarId:event.calendarId,status:event.appointmentStatus,startsAt:event.startTime,updatedAt:event.dateUpdated,bookingSetterId:null,applicationId:context.id,attribution:context.attribution});
  return {ok:true,booked:true,appointmentId:event.id,startTime:new Date(event.startTime).toISOString(),timezone:input.timezone};
}
async function book(context,input) {
  requireBooking(context);
  const result=await db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[context.cycle_id]);
    const {rows:[existing]}=await c.query('SELECT * FROM sog_booking_intents WHERE id=$1 FOR UPDATE',[input.bookingId]);
    if(existing) {
      if(existing.application_id!==context.id || Date.parse(existing.start_time)!==Date.parse(input.startTime))throw new InputError('booking_idempotency_conflict',409);
      return {intent:existing,created:false};
    }
    const active=await c.query("SELECT 1 FROM sog_booking_intents WHERE cycle_id=$1 AND state IN ('pending','uncertain','confirmed') LIMIT 1",[context.cycle_id]);
    if(active.rowCount)throw new InputError('booking_already_in_progress',409);
    const booked=await c.query("SELECT 1 FROM sog_appointments WHERE cycle_id=$1 AND status IN ('new','confirmed') LIMIT 1",[context.cycle_id]);
    if(booked.rowCount)throw new InputError('appointment_already_exists',409);
    if((await c.query('SELECT 1 FROM sog_events WHERE event_id=$1',[input.bookingId])).rowCount) throw new InputError('invalid_booking_id',409);
    await c.query("INSERT INTO sog_booking_intents(id,application_id,cycle_id,start_time,timezone,state) VALUES($1,$2,$3,$4,$5,'pending')",[input.bookingId,context.id,context.cycle_id,input.startTime,input.timezone]);
    return {created:true};
  });
  if(!result.created) {
    if(['conflict','failed','cancelled'].includes(result.intent.state))throw new InputError('choose_another_slot',409);
    const event=result.intent.appointment_id?await verifyAppointment(result.intent.appointment_id,context,input):await reconcile(context,input);
    if(event)return complete(context,input,event);
    return {ok:true,booked:false,pending:true,reason:'booking_verification_pending'};
  }
  try {
    const existing=await reconcile(context,input);
    if(existing)return complete(context,input,existing);
    // Re-read free slots immediately before create; never bypass calendar rules.
    const start=Date.parse(input.startTime);
    const available=await slots(context,{startDate:Math.max(Date.now(),start-3600000),endDate:start+3600000,timezone:input.timezone});
    if(!available.includes(input.startTime)) {await db.query("UPDATE sog_booking_intents SET state='conflict',updated_at=now() WHERE id=$1",[input.bookingId]);throw new InputError('slot_unavailable',409);}
    const created=await request('/calendars/events/appointments','POST',appointmentPayload(context,input));
    const createdId=created.id || created.appointment?.id;
    if(!createdId)throw new Error('ghl_booking_response_invalid');
    await db.query("UPDATE sog_booking_intents SET appointment_id=$2,updated_at=now() WHERE id=$1",[input.bookingId,createdId]);
    return complete(context,input,await verifyAppointment(createdId,context,input));
  } catch(error) {
    if(error instanceof InputError && ['slot_unavailable','appointment_already_exists'].includes(error.message)) {
      await db.query("UPDATE sog_booking_intents SET state='conflict',updated_at=now() WHERE id=$1",[input.bookingId]);
      throw error;
    }
    // A timeout or 5xx may follow a successful remote write: never POST again.
    const definitive=[400,401,403,404,409,422].includes(error.statusCode);
    await db.query('UPDATE sog_booking_intents SET state=$2,updated_at=now() WHERE id=$1 AND state<>\'confirmed\'',[input.bookingId,definitive?'failed':'uncertain']);
    if(definitive)throw new InputError(error.statusCode===409?'slot_unavailable':'booking_rejected',error.statusCode===409?409:503);
    return {ok:true,booked:false,pending:true,reason:'booking_verification_pending'};
  }
}
module.exports={claimFor,contextFor,config,requireBooking,range,slots,bookingInput,appointmentPayload,verifyAppointment,reconcile,book};
