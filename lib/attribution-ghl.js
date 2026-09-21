const {InputError} = require('./attribution');
const assignment = require('./attribution-assignment');
const LOCATION = '3mi3YQaZvtUMZzaQUuL6';
const CLOSERS = 'GxJOcIsgv7Svx90E2BZr';
async function request(path,method='GET',data) {
  const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
  if (!token || process.env.GHL_SYNC_ENABLED !== 'true') throw new InputError('ghl_sync_disabled',503);
  const response = await fetch('https://services.leadconnectorhq.com'+path,{method,headers:{Authorization:`Bearer ${token}`,Version:'2021-07-28','Content-Type':'application/json','User-Agent':'SchoolOfGains-Attribution/1.0'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(12000)});
  if (!response.ok) { const error=new Error('ghl_http_'+response.status);error.statusCode=response.status;throw error; }
  return response.json();
}
function mappings(name) { try { const value=JSON.parse(process.env[name] || '{}'); if(!value || Array.isArray(value) || typeof value!=='object') throw new Error(); return value; } catch {throw new Error('ghl_mapping_invalid');} }
const FIELD_KEYS=['application_id','cycle_id','quiz_version','answers','first_source','first_medium','first_campaign','latest_source','latest_medium','latest_campaign','first_touch_snapshot','latest_touch_snapshot','application_snapshot','privacy_consent','marketing_consent','consent_recorded_at','quiz_age_range','quiz_goals','quiz_weekly_time','quiz_education_budget','quiz_attendance','quiz_notes'];
function contactUpdate(input,application,canonical,remote,ids) {
  if(FIELD_KEYS.some(key=>!ids[key]))throw new Error('ghl_field_mapping_missing');
  const first=canonical.first_touch,latest=canonical.latest_touch;
  if(!first || !latest || !application.answers || !application.consent || !Number.isFinite(Date.parse(application.created_at)))throw new Error('ghl_application_data_incomplete');
  const submittedAt=new Date(application.created_at).toISOString(),answers=application.answers,consent=application.consent;
  const values={application_id:application.id,cycle_id:application.cycle_id,quiz_version:application.quiz_version,answers:JSON.stringify(answers),first_source:first.source || '',first_medium:first.medium || '',first_campaign:first.utm_campaign || '',latest_source:latest.source || '',latest_medium:latest.medium || '',latest_campaign:latest.utm_campaign || '',first_touch_snapshot:JSON.stringify(first),latest_touch_snapshot:JSON.stringify(latest),application_snapshot:JSON.stringify({schemaVersion:'sog-application-v1',applicationId:application.id,cycleId:application.cycle_id,journeyId:application.journey_id,quizVersion:application.quiz_version,submittedAt,answers,consent,attribution:application.attribution}),privacy_consent:String(consent.privacy===true),marketing_consent:String(consent.marketing===true),consent_recorded_at:submittedAt,quiz_age_range:answers.ageRange || '',quiz_goals:JSON.stringify(answers.goals || []),quiz_weekly_time:answers.weeklyTime || '',quiz_education_budget:answers.educationBudget || '',quiz_attendance:answers.attendance || '',quiz_notes:answers.notes || ''};
  const existing=new Map((remote.customFields || []).map(field=>[field.id,field.value ?? field.fieldValue]));
  const customFields=Object.entries(values).filter(([key])=>{
    // A DB import/rebuild must not overwrite an established GHL first touch.
    const prior=existing.get(ids[key]);return !key.startsWith('first_') || prior===undefined || prior===null || String(prior).trim()==='';
  }).map(([key,value])=>({id:ids[key],fieldValue:value}));
  const profile={};
  for(const key of ['firstName','lastName','phone'])if(typeof input.contact?.[key]==='string' && input.contact[key].trim())profile[key]=input.contact[key].trim();
  // Never reset native DND, tags, ownership or channel consent from a quiz.
  return {...profile,customFields};
}
async function syncFields(c,contactId,input) {
  const {rows:[latest]}=await c.query('SELECT id,created_at,answers,consent,attribution,quiz_version,journey_id,cycle_id FROM sog_applications WHERE contact_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[input.contactId]);
  if(!latest)throw new Error('ghl_application_not_found');
  if(latest.id!==input.submissionId)return false;
  const {rows:[canonical]}=await c.query('SELECT email,first_touch,latest_touch FROM sog_contacts WHERE id=$1',[input.contactId]);
  const {contact}=await request('/contacts/'+encodeURIComponent(contactId));
  if(!contact || contact.id!==contactId || (contact.locationId && contact.locationId!==LOCATION) || String(contact.email || '').trim().toLowerCase()!==canonical?.email)throw new Error('ghl_contact_identity_review_required');
  await request('/contacts/'+encodeURIComponent(contactId),'PUT',contactUpdate(input,latest,canonical,contact,mappings('GHL_ATTRIBUTION_FIELDS_JSON')));
  return true;
}
async function syncApplication(c,input) {
  if (!process.env.GHL_UNBOOKED_STAGE_ID) throw new InputError('ghl_routing_not_configured',503);
  const {rows:[local]} = await c.query('SELECT * FROM sog_contacts WHERE id=$1 FOR UPDATE',[input.contactId]);
  let contactId = local.ghl_contact_id;
  if(!contactId) {
    const result = await request('/contacts/upsert','POST',{locationId:LOCATION,email:local.email || input.contact.email});
    contactId=result.contact?.id; if(!contactId) throw new Error('ghl_contact_response_invalid');
    await c.query('UPDATE sog_contacts SET ghl_contact_id=$2 WHERE id=$1',[local.id,contactId]);
  }
  const {rows:[cycle]} = await c.query('SELECT * FROM sog_sales_cycles WHERE id=$1 FOR UPDATE',[input.cycleId]);
  if(cycle.ghl_opportunity_id) { await syncFields(c,contactId,input); return {contactId,opportunityId:cycle.ghl_opportunity_id}; }
  // Search before create on every retry: a network timeout after remote creation
  // must not blindly create another opportunity. Preserve established ownership/stage.
  const search = new URLSearchParams({location_id:LOCATION,contact_id:contactId,pipeline_id:CLOSERS,limit:'100',status:'all'});
  const result = await request('/opportunities/search?'+search);
  const opportunities = result.opportunities || [];
  if(result.meta?.nextPage || opportunities.length>=100) throw new Error('ghl_opportunity_review_required');
  const active=opportunities.filter(o=>o.status==='open');
  if(active.length>1) throw new Error('ghl_multiple_active_opportunities');
  let opportunity=active[0];
  if(!opportunity && opportunities.some(o=>o.status==='won')) {
    await c.query("UPDATE sog_sales_cycles SET status='review',stage='customer_review' WHERE id=$1",[cycle.id]);
    await syncFields(c,contactId,input);
    return {contactId,review:true};
  }
  let reservedCloserId;
  if(!opportunity) {
    // OpportunityCreated automations must see the durable application fields.
    // Superseded jobs leave creation to the latest submission's queued job.
    if(!await syncFields(c,contactId,input))return {contactId,superseded:true};
    const assignedTo=await assignment.reserveCloser(cycle.id);
    reservedCloserId=assignedTo;
    const created=await request('/opportunities/','POST',{locationId:LOCATION,pipelineId:CLOSERS,pipelineStageId:process.env.GHL_UNBOOKED_STAGE_ID,contactId,name:(process.env.ATTRIBUTION_PILOT_EMAILS || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).includes(local.email || input.contact?.email)?'TEST — Apprentice attribution verification':'Apprentice application',status:'open',assignedTo});
    opportunity=created.opportunity;
  }
  if(!opportunity?.id) throw new Error('ghl_opportunity_response_invalid');
  await c.query('UPDATE sog_sales_cycles SET ghl_opportunity_id=$2,assigned_closer_id=$3 WHERE id=$1',[cycle.id,opportunity.id,opportunity.assignedTo || reservedCloserId || null]);
  const remoteStage=Object.entries(mappings('GHL_STAGE_IDS_JSON')).find(([,id])=>id===opportunity.pipelineStageId)?.[0];
  await c.query('UPDATE sog_sales_cycles SET stage=$2 WHERE id=$1',[cycle.id,remoteStage || (reservedCloserId?'unbooked':'legacy_review')]);
  if(!reservedCloserId)await syncFields(c,contactId,input);
  // No Quiz Submitted trigger and no booked status on application.
  return {contactId,opportunityId:opportunity.id};
}
async function syncAppointment(c,input) {
  const {rows:[cycle]}=await c.query('SELECT * FROM sog_sales_cycles WHERE id=$1 FOR UPDATE',[input.cycleId]);
  if(!cycle?.ghl_opportunity_id) throw new Error('ghl_opportunity_not_linked');
  if(cycle.status!=='open') return;
  let stages; try{stages=JSON.parse(process.env.GHL_STAGE_IDS_JSON || '{}');}catch{throw new Error('ghl_stage_mapping_invalid');}
  const target=stages[cycle.stage];
  if(!target) throw new Error('ghl_stage_mapping_missing');
  const {opportunity}=await request('/opportunities/'+encodeURIComponent(cycle.ghl_opportunity_id));
  if(!opportunity || opportunity.pipelineId!==CLOSERS) throw new Error('ghl_opportunity_review_required');
  if(opportunity.status!=='open') return;
  const remoteStage=Object.entries(stages).find(([,id])=>id===opportunity.pipelineStageId)?.[0];
  // Unknown legacy stages require explicit mapping rather than risking regression.
  if(!remoteStage) throw new Error('ghl_remote_stage_unmapped');
  if(['call_held','follow_up'].includes(remoteStage) && ['unbooked','booked','no_show'].includes(cycle.stage)) return;
  await request('/opportunities/'+encodeURIComponent(cycle.ghl_opportunity_id),'PUT',{pipelineStageId:target});
}
module.exports = {syncApplication,syncAppointment,request,contactUpdate,FIELD_KEYS};
