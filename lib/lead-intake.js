const {randomUUID}=require('node:crypto');
const {InputError,attribution,mergeTouches}=require('./attribution');
const db=require('./attribution-db');
const OFFERS=Object.freeze(['community','newsletter','free_lessons','free_tools','webinar']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text=(value,max=100)=>typeof value==='string'?value.trim().slice(0,max):'';
function lead(body,options={}) {
 if(!body || typeof body!=='object' || Array.isArray(body))throw new InputError('invalid_body');
 if(!UUID.test(body.submissionId || '') || !UUID.test(body.journeyId || ''))throw new InputError('invalid_id');
 if(body.website)throw new InputError('invalid_submission');
 const offer=options.offer || body.offer;
 if(!OFFERS.includes(offer))throw new InputError('invalid_offer');
 const email=text(body.contact?.email,254).toLowerCase(),phone=text(body.contact?.phone,30);
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new InputError('invalid_email');
 if(phone && !/^\+?[\d ()-]{7,30}$/.test(phone))throw new InputError('invalid_phone');
 if(body.consent?.privacy!==true)throw new InputError('privacy_consent_required');
 return {submissionId:body.submissionId,journeyId:body.journeyId,offer,contact:{email,firstName:text(body.contact?.firstName),lastName:text(body.contact?.lastName),phone},consent:{privacy:true,marketing:body.consent.marketing===true},attribution:attribution(body.attribution)};
}
async function saveLead(input,deps={}) {return (deps.db || db).transaction(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.contact.email]);
 const {rows:[duplicate]}=await c.query('SELECT l.id,l.offer,c.email FROM sog_lead_captures l JOIN sog_contacts c ON c.id=l.contact_id WHERE l.id=$1',[input.submissionId]);
 if(duplicate){if(duplicate.email!==input.contact.email || duplicate.offer!==input.offer)throw new InputError('idempotency_conflict',409);return {leadId:input.submissionId,duplicate:true};}
 // Reject IDs used by a different event kind before any capture is recorded.
 if((await c.query('SELECT 1 FROM sog_events WHERE event_id=$1',[input.submissionId])).rowCount)throw new InputError('idempotency_conflict',409);
 await c.query('INSERT INTO sog_journeys(id,first_touch,latest_touch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.journeyId,input.attribution.firstTouch,input.attribution.latestTouch]);
 const {rows:[journey]}=await c.query('SELECT * FROM sog_journeys WHERE id=$1 FOR UPDATE',[input.journeyId]);
 const journeyTouch=mergeTouches({firstTouch:journey.first_touch,latestTouch:journey.latest_touch},input.attribution);
 await c.query('UPDATE sog_journeys SET latest_touch=$2 WHERE id=$1',[input.journeyId,journeyTouch.latestTouch]);
 await c.query('INSERT INTO sog_contacts(id,email,first_touch,latest_touch) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING',[randomUUID(),input.contact.email,journeyTouch.firstTouch,journeyTouch.latestTouch]);
 const {rows:[contact]}=await c.query('SELECT * FROM sog_contacts WHERE email=$1 FOR UPDATE',[input.contact.email]);
 // Internal provider readback may bind an existing verified contact; browser validation drops this key.
 if(input.ghlContactId){
  if(contact.ghl_contact_id && contact.ghl_contact_id!==input.ghlContactId)throw new InputError('provider_contact_identity_conflict',409);
  await c.query('UPDATE sog_contacts SET ghl_contact_id=$2 WHERE id=$1',[contact.id,input.ghlContactId]);
 }
 const incoming=input.ghlContactId && journeyTouch.latestTouch.source==='unknown' && contact.latest_touch
  ? {...journeyTouch,latestTouch:contact.latest_touch}:journeyTouch;
 const snapshot=mergeTouches({firstTouch:contact.first_touch,latestTouch:contact.latest_touch},incoming);
 await c.query('UPDATE sog_contacts SET latest_touch=$2 WHERE id=$1',[contact.id,snapshot.latestTouch]);
 // One prospecting record across offers: repeat downloads must not reset sales progress.
 await c.query('INSERT INTO sog_lead_cycles(id,contact_id,entry_offer) VALUES($1,$2,$3) ON CONFLICT(contact_id) DO NOTHING',[randomUUID(),contact.id,input.offer]);
 const {rows:[cycle]}=await c.query('SELECT * FROM sog_lead_cycles WHERE contact_id=$1 FOR UPDATE',[contact.id]);
 await c.query('INSERT INTO sog_events(event_id,type,journey_id,contact_id,payload) VALUES($1,$2,$3,$4,$5)',[input.submissionId,'lead_captured',input.journeyId,contact.id,{offer:input.offer,attribution:snapshot}]);
 await c.query('INSERT INTO sog_lead_captures(id,contact_id,journey_id,lead_cycle_id,offer,profile,consent,attribution) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[input.submissionId,contact.id,input.journeyId,cycle.id,input.offer,input.contact,input.consent,snapshot]);
 await c.query('INSERT INTO sog_outbox(event_id,type,payload) VALUES($1,$2,$3)',[input.submissionId,'lead',{submissionId:input.submissionId,contactId:contact.id,leadCycleId:cycle.id}]);
 return {leadId:input.submissionId,duplicate:false};
});}
module.exports={lead,saveLead,OFFERS};
