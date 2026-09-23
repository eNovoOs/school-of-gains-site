const {randomUUID}=require('node:crypto');
const {InputError,assert,touch}=require('./attribution');
const {eventId}=require('./ghl-signal');
const db=require('./attribution-db');
const provider=require('./attribution-ghl');
const {OFFERS,saveLead}=require('./lead-intake');
const {assertPilotContact}=require('./intake-pilot');
const LOCATION='3mi3YQaZvtUMZzaQUuL6';
const validId=value=>typeof value==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
function routes(env=process.env){let registry;try{registry=JSON.parse(env.GHL_LEAD_CAPTURE_ROUTES_JSON || '{}');}catch{throw new InputError('lead_capture_routes_invalid',503);}if(!registry || Array.isArray(registry) || typeof registry!=='object' || !Object.keys(registry).length || Object.entries(registry).some(([key,offer])=>!validId(key) || !OFFERS.includes(offer)))throw new InputError('lead_capture_routes_invalid',503);return registry;}
function signal(input,env=process.env){
 if(input && Object.prototype.hasOwnProperty.call(input,'customData')){
  const custom=input.customData;assert(custom && typeof custom==='object' && !Array.isArray(custom),'invalid_custom_data');
  for(const key of ['locationId','contactId','captureKey'])if(input[key]!==undefined && custom[key]!==undefined)assert(input[key]===custom[key],'conflicting_signal_fields');
  if(input.location?.id!==undefined)assert(input.location.id===custom.locationId,'conflicting_signal_location');
  if(input.contact_id!==undefined)assert(input.contact_id===custom.contactId,'conflicting_signal_contact');
  input=custom;
 }
 assert(input?.locationId===LOCATION,'invalid_location');assert(validId(input.contactId),'invalid_contact_id');assert(validId(input.captureKey),'invalid_capture_key');
 const registry=routes(env);assert(Object.hasOwn(registry,input.captureKey),'capture_key_not_allowed');
 return {contactId:input.contactId,captureKey:input.captureKey,offer:registry[input.captureKey]};
}
// Native field names: https://help.gohighlevel.com/support/solutions/articles/48001078171
// Contact.source is a separate manually-set field, not native attribution.
function nativeTouch(value){
 if(!value || typeof value!=='object' || Array.isArray(value))return {};
 const raw={};
 const clean=value=>typeof value==='string'?value.trim().slice(0,200):'';
 // Retain only known tracking query keys, never the full URL query (which may contain PII).
 try{const url=new URL(value.url);if(['https:','http:'].includes(url.protocol)){
  raw.landing_page=url.origin+url.pathname;
  for(const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id','gclid','fbclid','gbraid','wbraid','ttclid'])if(clean(url.searchParams.get(key)))raw[key]=clean(url.searchParams.get(key));
 }}catch{}
 for(const [from,to] of Object.entries({utmSource:'utm_source',utmMedium:'utm_medium',utmCampaign:'utm_campaign',utmContent:'utm_content',utmKeyword:'utm_term'}))if(clean(value[from]))raw[to]=clean(value[from]);
 if(!raw.utm_campaign && clean(value.campaign))raw.utm_campaign=clean(value.campaign);
 if(typeof value.referrer==='string')raw.referrer=value.referrer;
 // A generic clickId does not identify its advertising provider. Preserve its
 // native name instead of falsely promoting it to gclid/fbclid or a UTM value.
 for(const key of ['sessionSource','campaignId','clickId','utmMatchType','adGroupId','adId'])if(clean(value[key]))raw['ghl_'+key]=clean(value[key]);
 return raw;
}
function remoteAttribution(contact,env=process.env){
 let ids;try{ids=JSON.parse(env.GHL_ATTRIBUTION_FIELDS_JSON || '{}');}catch{throw new InputError('ghl_mapping_invalid',503);}
 if(!ids || Array.isArray(ids) || typeof ids!=='object')throw new InputError('ghl_mapping_invalid',503);
 const fields=new Map((Array.isArray(contact.customFields)?contact.customFields:[]).map(field=>[field.id,field.value ?? field.fieldValue]));
 const read=key=>fields.get(ids[key]);
 const decode=prefix=>{
  let raw;try{const value=read(prefix+'_touch_snapshot');raw=typeof value==='string'?JSON.parse(value):value;}catch{}
  if(!raw || typeof raw!=='object' || Array.isArray(raw))raw={};
  const hasSnapshot=Object.keys(raw).length>0;
  const hasScalars=['source','medium','campaign'].some(key=>typeof read(prefix+'_'+key)==='string' && read(prefix+'_'+key).trim());
  let provenance='sog_snapshot';
  // Never mix native latest fields into a saved SOG first-touch snapshot.
  if(!hasSnapshot && !hasScalars){raw=nativeTouch(prefix==='first'?contact.attributionSource:contact.lastAttributionSource);provenance='ghl_native';}
  else if(!hasSnapshot)provenance='sog_fields';
  const result=touch(raw);
  for(const key of ['source','medium']){
   const value=raw[key] || (provenance!=='ghl_native'?read(prefix+'_'+key):'');
   result[key]=typeof value==='string' && value.trim()?value.trim().slice(0,200):raw['utm_'+key]?result[key]:'unknown';
  }
  if(!result.utm_campaign && provenance!=='ghl_native' && typeof read(prefix+'_campaign')==='string')result.utm_campaign=read(prefix+'_campaign').slice(0,200);
  if(typeof raw.captured_at==='string' && Number.isFinite(Date.parse(raw.captured_at)) && Date.parse(raw.captured_at)<=Date.now()+300000)result.captured_at=new Date(raw.captured_at).toISOString();
  result.confidence=['explicit','inferred','unknown'].includes(raw.confidence)?raw.confidence:raw.utm_source?'explicit':'unknown';
  for(const key of ['sessionSource','campaignId','clickId','utmMatchType','adGroupId','adId'])if(raw['ghl_'+key])result['ghl_'+key]=raw['ghl_'+key];
  result.attribution_origin=provenance;
  if(provenance==='ghl_native')result.timestamp_basis='provider_readback';
  return result;
 };
 return {firstTouch:decode('first'),latestTouch:decode('latest')};
}
async function normalize(input,read=provider.request,env=process.env){
 const {contact}=await read('/contacts/'+encodeURIComponent(input.contactId));
 if(!contact || contact.id!==input.contactId || contact.locationId!==LOCATION)throw new InputError('provider_identity_mismatch',422);
 const email=String(contact.email || '').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new InputError('provider_email_required',422);
 assertPilotContact(email,env);
 const projection={kind:'ghl_lead_capture_v1',locationId:LOCATION,contactId:contact.id,captureKey:input.captureKey};
 const clean=value=>typeof value==='string'?value.trim().slice(0,100):'';
 return {submissionId:eventId(projection),journeyId:eventId({kind:'ghl_contact_journey_v1',locationId:LOCATION,contactId:contact.id}),offer:input.offer,ghlContactId:contact.id,contact:{email,firstName:clean(contact.firstName),lastName:clean(contact.lastName),phone:clean(contact.phone)},consent:{privacy:null,marketing:false,basis:'existing_ghl_contact'},attribution:remoteAttribution(contact,env)};
}
async function enqueue(input,storage=db){const receiptId=randomUUID();await storage.query('INSERT INTO sog_lead_capture_signals(id,ghl_contact_id,capture_key,offer) VALUES($1,$2,$3,$4)',[receiptId,input.contactId,input.captureKey,input.offer]);return {receiptId,accepted:true};}
async function processOne(deps={}){
 const storage=deps.db || db,read=deps.read || provider.request;
 const job=await storage.transaction(async c=>{
  const {rows:[row]}=await c.query("SELECT * FROM sog_lead_capture_signals WHERE status='pending' AND available_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
  if(!row)return null;
  if(row.attempts>=10){await c.query("UPDATE sog_lead_capture_signals SET status='failed',last_error='lead_signal_retry_exhausted',lease_until=NULL,claim_token=NULL WHERE id=$1",[row.id]);return {exhausted:true};}
  const claimToken=randomUUID();await c.query("UPDATE sog_lead_capture_signals SET claim_token=$2,lease_until=now()+interval '90 seconds',attempts=attempts+1 WHERE id=$1",[row.id,claimToken]);return {...row,claimToken,attempts:row.attempts+1};
 });
 if(!job)return {processed:0};if(job.exhausted)return {processed:0,needsReview:true};
 try{
  const payload=await normalize({contactId:job.ghl_contact_id,captureKey:job.capture_key,offer:job.offer},read,deps.env || process.env);
  await (deps.saveLead || saveLead)(payload,{db:storage});
  const done=await storage.query("UPDATE sog_lead_capture_signals SET status='delivered',normalized_event_id=$2,last_error=NULL,lease_until=NULL,claim_token=NULL,processed_at=now() WHERE id=$1 AND claim_token=$3",[job.id,payload.submissionId,job.claimToken]);
  return done.rowCount?{processed:1}:{processed:0,lostLease:true};
 }catch(error){
  const code=error instanceof InputError?error.message:/^ghl_http_\d{3}$/.test(error.message)?error.message:'lead_signal_processing_failed';
  const terminal=error instanceof InputError && [400,403,409,422].includes(error.status);
  await storage.query("UPDATE sog_lead_capture_signals SET status=CASE WHEN $3::boolean OR attempts>=10 THEN 'failed' ELSE 'pending' END,last_error=$2,available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,10)-1))::int),lease_until=NULL,claim_token=NULL WHERE id=$1 AND claim_token=$4",[job.id,code,terminal,job.claimToken]);
  return {processed:0,retryQueued:!terminal && job.attempts<10,needsReview:terminal || job.attempts>=10};
 }
}
module.exports={signal,routes,remoteAttribution,normalize,enqueue,processOne};
