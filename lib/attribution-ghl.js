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
async function syncFields(c,contactId,input) {
  const {rows:[latest]}=await c.query('SELECT id FROM sog_applications WHERE contact_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[input.contactId]);
  if(latest && latest.id!==input.submissionId) return;
  const ids=mappings('GHL_ATTRIBUTION_FIELDS_JSON');
  const values={application_id:input.submissionId,cycle_id:input.cycleId,quiz_version:input.quizVersion,answers:JSON.stringify(input.answers),first_source:input.attribution.firstTouch.source,first_medium:input.attribution.firstTouch.medium,first_campaign:input.attribution.firstTouch.utm_campaign || '',latest_source:input.attribution.latestTouch.source,latest_medium:input.attribution.latestTouch.medium,latest_campaign:input.attribution.latestTouch.utm_campaign || ''};
  if(Object.keys(values).some(k=>!ids[k])) throw new Error('ghl_field_mapping_missing');
  await request('/contacts/'+encodeURIComponent(contactId),'PUT',{customFields:Object.entries(values).map(([key,value])=>({id:ids[key],fieldValue:value}))});
}
async function syncApplication(c,input) {
  if (!process.env.GHL_UNBOOKED_STAGE_ID) throw new InputError('ghl_routing_not_configured',503);
  const {rows:[local]} = await c.query('SELECT * FROM sog_contacts WHERE id=$1 FOR UPDATE',[input.contactId]);
  let contactId = local.ghl_contact_id;
  if(!contactId) {
    const result = await request('/contacts/upsert','POST',{locationId:LOCATION,email:input.contact.email,firstName:input.contact.firstName,lastName:input.contact.lastName,...(input.contact.phone?{phone:input.contact.phone}:{} )});
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
    const assignedTo=await assignment.reserveCloser(cycle.id);
    reservedCloserId=assignedTo;
    const created=await request('/opportunities/','POST',{locationId:LOCATION,pipelineId:CLOSERS,pipelineStageId:process.env.GHL_UNBOOKED_STAGE_ID,contactId,name:'Apprentice application',status:'open',assignedTo});
    opportunity=created.opportunity;
  }
  if(!opportunity?.id) throw new Error('ghl_opportunity_response_invalid');
  await c.query('UPDATE sog_sales_cycles SET ghl_opportunity_id=$2,assigned_closer_id=$3 WHERE id=$1',[cycle.id,opportunity.id,opportunity.assignedTo || reservedCloserId || null]);
  const remoteStage=Object.entries(mappings('GHL_STAGE_IDS_JSON')).find(([,id])=>id===opportunity.pipelineStageId)?.[0];
  if(remoteStage) await c.query('UPDATE sog_sales_cycles SET stage=$2 WHERE id=$1',[cycle.id,remoteStage]);
  await syncFields(c,contactId,input);
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
module.exports = {syncApplication,syncAppointment,request};
