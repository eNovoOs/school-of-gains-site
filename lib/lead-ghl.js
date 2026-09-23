const provider=require('./attribution-ghl');
const {InputError}=require('./attribution');
let creationPool;
async function creationTransaction(fn) {
 if(!process.env.DATABASE_URL)throw new InputError('storage_unavailable',503);
 // Independent commit survives outbox rollback. No FK to the locked lead cycle.
 if(!creationPool){const {Pool}=require('pg');creationPool=new Pool({connectionString:process.env.DATABASE_URL,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:5000});}
 const c=await creationPool.connect();
 try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function reserveLeadCreation(cycleId,contactId,transaction=creationTransaction) {
 if(!/^[0-9a-f-]{36}$/i.test(cycleId || '') || !/^[a-zA-Z0-9_-]{1,100}$/.test(contactId || ''))throw new Error('ghl_lead_creation_identity_invalid');
 return transaction(async c=>{
  const result=await c.query('INSERT INTO sog_lead_creation_attempts(cycle_id,ghl_contact_id) VALUES($1,$2) ON CONFLICT(cycle_id) DO NOTHING RETURNING cycle_id',[cycleId,contactId]);
  return result.rowCount===1;
 });
}
async function closeLeadCreationPool(){if(creationPool){const current=creationPool;creationPool=undefined;await current.end();}}
const LOCATION='3mi3YQaZvtUMZzaQUuL6',SETTERS='PSq0fv77HbtMg9bdKC2p',CLOSERS='GxJOcIsgv7Svx90E2BZr';
// Snapshot of the user's two active pipelines, 2026-09-22. Offers, never UTMs, choose entry stages.
const ENTRY_STAGES=Object.freeze({community:'83c40d3b-0ac1-4cc1-abf2-8fa1dfa5dd87',newsletter:'83c40d3b-0ac1-4cc1-abf2-8fa1dfa5dd87',free_lessons:'be344857-5b67-49d1-b335-448008529a2e',free_tools:'34a06937-fb74-47ff-aa95-d8319893af24',webinar:'b6bc69f0-347f-4eb4-917a-f92e00a94684'});
const ATTR_FIELDS=['first_source','first_medium','first_campaign','latest_source','latest_medium','latest_campaign','first_touch_snapshot','latest_touch_snapshot'];
function leadContactUpdate(canonical,profile,remote,ids) {
 if(ATTR_FIELDS.some(key=>!ids[key]))throw new Error('ghl_field_mapping_missing');
 const first=canonical.first_touch,latest=canonical.latest_touch;
 if(!first || !latest)throw new Error('ghl_lead_data_incomplete');
 const values={first_source:first.source || '',first_medium:first.medium || '',first_campaign:first.utm_campaign || '',latest_source:latest.source || '',latest_medium:latest.medium || '',latest_campaign:latest.utm_campaign || '',first_touch_snapshot:JSON.stringify(first),latest_touch_snapshot:JSON.stringify(latest)};
 const existing=new Map((remote.customFields || []).map(field=>[field.id,field.value ?? field.fieldValue]));
 const customFields=Object.entries(values).filter(([key])=>!key.startsWith('first_') || existing.get(ids[key])==null || String(existing.get(ids[key])).trim()==='').map(([key,fieldValue])=>({id:ids[key],fieldValue}));
 const update={customFields};
 for(const key of ['firstName','lastName','phone'])if(typeof profile?.[key]==='string' && profile[key].trim() && !String(remote[key] || '').trim())update[key]=profile[key].trim();
 // Only fill missing profile fields: a delayed signup must not overwrite a newer quiz or staff edit.
 // Lead capture never resets application answers/consent, native DND, tags or ownership.
 return update;
}
function selectOpportunity(opportunities) {
 const closers=opportunities.filter(o=>o.pipelineId===CLOSERS && ['open','won'].includes(o.status));
 if(closers.length)return {preserveCloser:true};
 const setters=opportunities.filter(o=>o.pipelineId===SETTERS),active=setters.filter(o=>o.status==='open');
 if(active.length>1)throw new Error('ghl_multiple_active_opportunities');
 if(active[0])return {opportunity:active[0]};
 if(setters.length)return {review:true}; // Never reopen closed prospecting implicitly.
 return {};
}
async function syncLead(c,input,deps={}) {
 const request=deps.request || provider.request;
 const {rows:[local]}=await c.query('SELECT * FROM sog_contacts WHERE id=$1 FOR UPDATE',[input.contactId]);
 const {rows:[cycle]}=await c.query('SELECT * FROM sog_lead_cycles WHERE id=$1 AND contact_id=$2 FOR UPDATE',[input.leadCycleId,input.contactId]);
 if(!local || !cycle || !ENTRY_STAGES[cycle.entry_offer])throw new Error('ghl_lead_data_incomplete');
 const {rows:[capture]}=await c.query('SELECT * FROM sog_lead_captures WHERE contact_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[local.id]);
 if(!capture)throw new Error('ghl_lead_data_incomplete');
 let contactId=local.ghl_contact_id;
 if(!contactId){const result=await request('/contacts/upsert','POST',{locationId:LOCATION,email:local.email});contactId=result.contact?.id;if(!contactId)throw new Error('ghl_contact_response_invalid');await c.query('UPDATE sog_contacts SET ghl_contact_id=$2 WHERE id=$1',[local.id,contactId]);}
 const {contact}=await request('/contacts/'+encodeURIComponent(contactId));
 if(!contact || contact.id!==contactId || (contact.locationId && contact.locationId!==LOCATION) || String(contact.email || '').trim().toLowerCase()!==local.email)throw new Error('ghl_contact_identity_review_required');
 let ids;try{ids=JSON.parse(process.env.GHL_ATTRIBUTION_FIELDS_JSON || '{}');}catch{throw new Error('ghl_mapping_invalid');}
 await request('/contacts/'+encodeURIComponent(contactId),'PUT',leadContactUpdate(local,capture.profile,contact,ids || {}));
 // Qualification queued locally already supersedes prospecting even before its CRM job runs.
 const qualified=await c.query("SELECT 1 FROM sog_sales_cycles WHERE contact_id=$1 AND status IN ('open','review','won') LIMIT 1",[local.id]);
 if(qualified.rowCount){await c.query("UPDATE sog_lead_cycles SET status='superseded' WHERE id=$1",[cycle.id]);return {contactId,preserveCloser:true};}
 const search=new URLSearchParams({location_id:LOCATION,contact_id:contactId,limit:'100',status:'all'});
 const result=await request('/opportunities/search?'+search);
 if(!Array.isArray(result.opportunities) || result.meta?.nextPage || result.opportunities.length>=100)throw new Error('ghl_opportunity_review_required');
 const found=selectOpportunity(result.opportunities);
 if(found.preserveCloser || found.review){await c.query('UPDATE sog_lead_cycles SET status=$2 WHERE id=$1',[cycle.id,found.preserveCloser?'superseded':'review']);return {contactId,...found};}
 let opportunity=found.opportunity;
 let entryOffer=cycle.entry_offer;
 // Generic Contact Created can precede a specific form signal. Choose the first
 // specific capture, not the latest capture (which may itself be generic).
 if(cycle.status==='open' && ['community','newsletter'].includes(entryOffer)) {
  const {rows:[specific]}=await c.query("SELECT offer FROM sog_lead_captures WHERE lead_cycle_id=$1 AND offer IN ('free_lessons','free_tools','webinar') ORDER BY created_at ASC,id ASC LIMIT 1",[cycle.id]);
  if(specific && ((!opportunity && !cycle.ghl_opportunity_id) || (opportunity && !opportunity.assignedTo && opportunity.status==='open' && opportunity.pipelineStageId===ENTRY_STAGES.community))) {
   // Never refine an owned, progressed or already-specific remote deal.
   if(opportunity) {
    await request('/opportunities/'+encodeURIComponent(opportunity.id),'PUT',{pipelineStageId:ENTRY_STAGES[specific.offer]});
    opportunity={...opportunity,pipelineStageId:ENTRY_STAGES[specific.offer]};
   }
   entryOffer=specific.offer;
   await c.query('UPDATE sog_lead_cycles SET entry_offer=$2 WHERE id=$1',[cycle.id,entryOffer]);
  } else if(specific && opportunity && !opportunity.assignedTo && opportunity.status==='open' && opportunity.pipelineStageId===ENTRY_STAGES[specific.offer]) {
   // Reconcile a successful prior refinement whose local transaction rolled back.
   entryOffer=specific.offer;
   await c.query('UPDATE sog_lead_cycles SET entry_offer=$2 WHERE id=$1',[cycle.id,entryOffer]);
  }
 }

 // A missing linked remote record is a review case, not permission to recreate it.
 if(!opportunity && (cycle.ghl_opportunity_id || cycle.status!=='open')){await c.query("UPDATE sog_lead_cycles SET status='review' WHERE id=$1",[cycle.id]);return {contactId,review:true};}
 if(!opportunity){
  // An empty eventually-consistent search is not proof a timed-out POST failed.
  // Reserve exactly once before POST, durably outside the delivery transaction.
  if(!await (deps.reserveCreation || reserveLeadCreation)(cycle.id,contactId))throw new Error('ghl_lead_creation_uncertain_review_required');
  const created=await request('/opportunities/','POST',{locationId:LOCATION,pipelineId:SETTERS,pipelineStageId:ENTRY_STAGES[entryOffer],contactId,name:'School of Gains — '+entryOffer.replace(/_/g,' '),status:'open'});opportunity=created.opportunity;}
 if(!opportunity?.id)throw new Error('ghl_opportunity_response_invalid');
 await c.query('UPDATE sog_lead_cycles SET ghl_opportunity_id=$2,stage=$3 WHERE id=$1',[cycle.id,opportunity.id,opportunity.pipelineStageId || ENTRY_STAGES[entryOffer]]);
 return {contactId,opportunityId:opportunity.id};
}
module.exports={reserveLeadCreation,closeLeadCreationPool,syncLead,leadContactUpdate,selectOpportunity,ENTRY_STAGES,ATTR_FIELDS,SETTERS,CLOSERS};
