const {InputError}=require('./attribution');
const db=require('./attribution-db');
const {normalize}=require('./ghl-signal');
const {request}=require('./attribution-ghl');
const {assertPilotContact}=require('./intake-pilot');
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
function setterRoster(env=process.env){
 let roster;try{roster=JSON.parse(env.SETTER_CREDIT_SETTERS_JSON||'[]');}catch{throw new InputError('setter_roster_invalid',503);}
 if(!Array.isArray(roster)||!roster.length||roster.length>100||roster.some(s=>!s||!validId(s.id)||typeof s.name!=='string'||!s.name.trim()||s.name.length>100)||new Set(roster.map(s=>s.id)).size!==roster.length)throw new InputError('setter_roster_invalid',503);
 return roster.map(({id,name})=>({id,name}));
}
function parseAttestation(input,env=process.env){
 if(!input||!validId(input.appointmentId)||!validId(input.setterId)||typeof input.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId))throw new InputError('credit_input_invalid');
 if(!setterRoster(env).some(s=>s.id===input.setterId))throw new InputError('setter_not_allowed',403);
 if(typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>500)throw new InputError('credit_reason_required');
 return {appointmentId:input.appointmentId,setterId:input.setterId,requestId:input.requestId,reason:input.reason.trim()};
}
async function attest(input,adminSessionHash,deps={}){
 const env=deps.env||process.env;
 if(env.SETTER_CREDIT_ENABLED!=='true')throw new InputError('setter_credit_disabled',503);
 const data=parseAttestation(input,env),storage=deps.db||db,read=deps.read||request;
 if(!/^[a-f0-9]{64}$/.test(adminSessionHash||''))throw new InputError('admin_evidence_missing',403);
 const {rows:[linked]}=await storage.query('SELECT a.id,c.email,c.ghl_contact_id FROM sog_appointments a JOIN sog_contacts c ON c.id=a.contact_id WHERE a.id=$1',[data.appointmentId]);
 if(!linked)throw new InputError('verified_booking_required',409);
 assertPilotContact(linked.email,env);
 const verified=await normalize({kind:'appointment',resourceId:data.appointmentId,contactId:linked.ghl_contact_id},read);
 // Normalize enforces configured calendar, location, exact appointment/contact,
 // status and provider revision. Also confirm current provider contact identity.
 const {contact}=await read('/contacts/'+encodeURIComponent(verified.contactId));
 if(!contact||contact.id!==linked.ghl_contact_id||contact.locationId!==verified.locationId||String(contact.email||'').trim().toLowerCase()!==linked.email)throw new InputError('credit_contact_mismatch',422);
 return storage.transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['setter-credit:'+data.requestId]);
  const {rows:[appointment]}=await c.query("SELECT a.*,c.ghl_contact_id FROM sog_appointments a JOIN sog_contacts c ON c.id=a.contact_id WHERE a.id=$1 AND EXISTS (SELECT 1 FROM sog_events e WHERE e.type IN ('appointment_new','appointment_confirmed') AND e.payload->>'appointmentId'=a.id) FOR UPDATE OF a",[data.appointmentId]);
  if(!appointment||appointment.ghl_contact_id!==verified.contactId)throw new InputError('verified_booking_required',409);
  const {rows:[priorRequest]}=await c.query('SELECT * FROM sog_booking_setter_credits WHERE request_id=$1',[data.requestId]);
  if(priorRequest&&(priorRequest.appointment_id!==data.appointmentId||priorRequest.setter_id!==data.setterId||priorRequest.reason!==data.reason))throw new InputError('credit_request_conflict',409);
  const {rows:[credit]}=await c.query('SELECT * FROM sog_booking_setter_credits WHERE appointment_id=$1',[data.appointmentId]);
  if(credit){
   if(credit.setter_id!==data.setterId)throw new InputError('credit_already_recorded',409);
   if(appointment.booking_setter_id!==credit.setter_id)throw new InputError('credit_ledger_conflict',409);
   return {recorded:true,duplicate:true,evidenceType:credit.evidence_type};
  }
  if(appointment.booking_setter_id&&appointment.booking_setter_id!==data.setterId)throw new InputError('credit_already_recorded',409);
  await c.query("INSERT INTO sog_booking_setter_credits(appointment_id,setter_id,evidence_type,request_id,reason,admin_session_hash,provider_revision) VALUES($1,$2,'admin_attested',$3,$4,$5,$6)",[data.appointmentId,data.setterId,data.requestId,data.reason,adminSessionHash,verified.updatedAt]);
  await c.query('UPDATE sog_appointments SET booking_setter_id=$2 WHERE id=$1',[data.appointmentId,data.setterId]);
  // Do not change salesperson ownership, appointment host, pipeline stage or
  // cycle-level credit: different appointments may have different booking setters.
  return {recorded:true,duplicate:false,evidenceType:'admin_attested'};
 });
}
module.exports={setterRoster,parseAttestation,attest};
