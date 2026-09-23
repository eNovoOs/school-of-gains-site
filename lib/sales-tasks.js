const {randomUUID}=require('node:crypto');
const db=require('./attribution-db');
const {request}=require('./attribution-ghl');
const {closerIds}=require('./attribution-assignment');
const {assertPilotContact}=require('./intake-pilot');
const {InputError}=require('./attribution');
const LOCATION='3mi3YQaZvtUMZzaQUuL6',CLOSERS='GxJOcIsgv7Svx90E2BZr';
const enabled=()=>process.env.GHL_TASKS_ENABLED==='true';
const review=code=>new InputError(code,422);
const validId=id=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const marker=job=>'School of Gains managed unbooked task '+job.id;
const isUnbooked=cycle=>cycle.status==='open' && cycle.stage==='unbooked';
function dueHours(){
 // Approved first-response SLA: within 24 hours. A shorter configured SLA is allowed.
 const value=Number(process.env.GHL_TASK_DUE_HOURS ?? 24);
 if(!Number.isFinite(value)||value<=0||value>24)throw new InputError('task_due_policy_missing',503);
 return value;
}
// Called inside the same transaction as cycle changes. The cycle lock serializes
// repeated applications and cancels; the partial index enforces one open episode.
async function reconcileCycle(c,cycleId){
 if(!enabled())return {disabled:true};
 const {rows:[cycle]}=await c.query("SELECT sc.*,ct.ghl_contact_id,(SELECT max(a.updated_at) FROM sog_appointments a WHERE a.cycle_id=sc.id AND a.status IN ('cancelled','invalid','noshow')) AS unbooked_returned_at FROM sog_sales_cycles sc JOIN sog_contacts ct ON ct.id=sc.contact_id WHERE sc.id=$1 FOR UPDATE OF sc",[cycleId]);
 if(!cycle)return {missing:true};
 if(!isUnbooked(cycle)){
  const reason=cycle.status!=='open'?'cycle_closed':cycle.stage==='booked'?'superseded_by_booking':'stage_changed';
  await c.query("UPDATE sog_sales_tasks SET desired_state='completed',completion_reason=$2,status='pending',available_at=now(),updated_at=now() WHERE cycle_id=$1 AND desired_state='open'",[cycleId,reason]);
  return {closing:true};
 }
 if(!validId(cycle.ghl_contact_id)||!validId(cycle.ghl_opportunity_id))return {waitingForSync:true};
 const {rows:[existing]}=await c.query("SELECT id FROM sog_sales_tasks WHERE cycle_id=$1 AND desired_state='open'",[cycleId]);
 if(existing)return {id:existing.id}; // Never reset due date or manual completion.
 // Initial applications start the SLA at cycle creation. A later verified
 // cancellation/no-show starts it at that event, including booked-first cycles.
 // Never reuse an older cancellation as the origin of a subsequent episode.
 const origin=deadlineOrigin(cycle);
 const {rows:[created]}=await c.query("INSERT INTO sog_sales_tasks(id,cycle_id,episode,ghl_contact_id,ghl_opportunity_id,due_at) SELECT $1,$2,COALESCE(MAX(episode),0)+1,$3,$4,CASE WHEN MAX(episode) IS NULL OR $6::timestamptz>MAX(created_at) THEN LEAST(now(),$6::timestamptz) ELSE now() END+make_interval(secs=>$5) FROM sog_sales_tasks WHERE cycle_id=$2 RETURNING id",[randomUUID(),cycleId,cycle.ghl_contact_id,cycle.ghl_opportunity_id,Math.round(dueHours()*3600),origin]);
 return {id:created.id,created:true};
}
function deadlineOrigin(cycle){
 const created=Date.parse(cycle.created_at),returned=Date.parse(cycle.unbooked_returned_at);
 if(!Number.isFinite(created))throw new InputError('task_cycle_time_missing',503);
 return Number.isFinite(returned)&&returned>created?cycle.unbooked_returned_at:cycle.created_at;
}
function verifyTask(task,job){
 if(!task||!validId(task.id)||task.contactId!==job.ghl_contact_id||task.body!==marker(job)||(job.provider_task_id&&task.id!==job.provider_task_id)||typeof task.completed!=='boolean')throw review('task_identity_mismatch');
 return task;
}
async function findTask(job,read=request){
 const base='/contacts/'+encodeURIComponent(job.ghl_contact_id)+'/tasks';
 if(job.provider_task_id)return verifyTask((await read(base+'/'+encodeURIComponent(job.provider_task_id))).task,job);
 const list=await read(base);
 if(!Array.isArray(list.tasks)||list.nextPage||list.meta?.nextPage||list.meta?.nextPageUrl||list.tasks.some(t=>!t||!validId(t.id)||t.contactId!==job.ghl_contact_id))throw review('task_list_incomplete');
 const matches=list.tasks.filter(t=>t.body===marker(job));
 if(matches.length>1)throw review('task_multiple_matches');
 return matches.length?verifyTask(matches[0],job):null;
}
function verifyOpportunity(value,job){
 const opportunity=value?.opportunity;
 if(!opportunity||opportunity.id!==job.ghl_opportunity_id||opportunity.contactId!==job.ghl_contact_id||opportunity.locationId!==LOCATION||opportunity.pipelineId!==CLOSERS)throw review('task_opportunity_mismatch');
 if(!['open','won','lost','abandoned'].includes(opportunity.status)||!validId(opportunity.pipelineStageId))throw review('task_opportunity_state_invalid');
 return opportunity;
}
async function processOne(deps={}){
 if(!enabled())return {processed:0,disabled:true};
 if(!validId(process.env.GHL_UNBOOKED_STAGE_ID))throw new InputError('task_stage_not_configured',503);
 const storage=deps.db||db,remote=deps.request||request;
 const job=await storage.transaction(async c=>{
  const {rows:[row]}=await c.query("SELECT * FROM sog_sales_tasks WHERE status<>'review' AND available_at<=now() AND (desired_state='open' OR status='pending') AND (lease_until IS NULL OR lease_until<=now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
  if(!row)return null;
  const token=randomUUID();
  await c.query("UPDATE sog_sales_tasks SET claim_token=$2,lease_until=now()+interval '120 seconds',attempts=attempts+1 WHERE id=$1",[row.id,token]);
  return {...row,claim_token:token};
 });
 if(!job)return {processed:0};
 async function owned(){
  const {rows:[fresh]}=await storage.query('SELECT * FROM sog_sales_tasks WHERE id=$1 AND claim_token=$2 AND lease_until>clock_timestamp()',[job.id,job.claim_token]);
  if(!fresh)throw review('task_lease_lost');
  return fresh;
 }
 async function finish(task,reason){
  const result=await storage.query("UPDATE sog_sales_tasks SET provider_task_id=COALESCE($3,provider_task_id),assigned_user_id=$4,provider_completed=$5,status=CASE WHEN desired_state='completed' AND NOT $5::boolean AND create_started_at IS NOT NULL THEN 'pending' ELSE 'synced' END,attempts=0,last_error=NULL,completion_reason=COALESCE(completion_reason,$6),available_at=now()+interval '5 minutes',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2 AND lease_until>clock_timestamp()",[job.id,job.claim_token,task?.id||null,task?.assignedTo||null,task?.completed===true,reason||null]);
  return {processed:result.rowCount?1:0,...(!result.rowCount?{lostLease:true}:{})};
 }
 try{
  const {rows:[cycle]}=await storage.query('SELECT sc.*,ct.email,ct.ghl_contact_id FROM sog_sales_cycles sc JOIN sog_contacts ct ON ct.id=sc.contact_id WHERE sc.id=$1',[job.cycle_id]);
  if(!cycle||cycle.ghl_contact_id!==job.ghl_contact_id||cycle.ghl_opportunity_id!==job.ghl_opportunity_id)throw review('task_cycle_mismatch');
  assertPilotContact(cycle.email);
  const opportunity=verifyOpportunity(await remote('/opportunities/'+encodeURIComponent(job.ghl_opportunity_id)),job);
  let task=await findTask(job,remote);
  let fresh=await owned();
  const providerUnbooked=opportunity.status==='open'&&opportunity.pipelineStageId===process.env.GHL_UNBOOKED_STAGE_ID;
  const shouldClose=fresh.desired_state==='completed'||!isUnbooked(cycle)||!providerUnbooked;
  if(shouldClose){
   // No creation happened, therefore nothing exists to complete.
   if(!task&&!fresh.create_started_at){
    await storage.query("UPDATE sog_sales_tasks SET desired_state='completed',completion_reason=COALESCE(completion_reason,'never_created') WHERE id=$1 AND claim_token=$2 AND lease_until>clock_timestamp()",[job.id,job.claim_token]);
    return finish(null,'never_created');
   }
   if(!task)throw new InputError('task_create_uncertain',503);
   if(!task.completed){
    await owned();
    await remote('/contacts/'+encodeURIComponent(job.ghl_contact_id)+'/tasks/'+encodeURIComponent(task.id),'PUT',{completed:true});
    task=await findTask({...job,provider_task_id:task.id},remote);
    if(!task.completed)throw new InputError('task_completion_unconfirmed',503);
   }
   // A fresh remote state may precede local signals. Close this episode as well.
   await storage.query("UPDATE sog_sales_tasks SET desired_state='completed',completion_reason=COALESCE(completion_reason,$3) WHERE id=$1 AND claim_token=$2 AND lease_until>clock_timestamp()",[job.id,job.claim_token,opportunity.status==='open'?'superseded_by_stage':'cycle_closed']);
   return finish(task);
  }
  if(task?.completed)return finish(task,'completed_by_salesperson');
  if(!closerIds().includes(opportunity.assignedTo))throw review('task_owner_not_closer');
  if(!task){
   if(fresh.create_started_at)throw new InputError('task_create_uncertain',503);
   // Committed before POST. Any crash after this point enters recovery only;
   // absence from an eventually consistent list never authorizes a second POST.
   const claimed=await storage.query("UPDATE sog_sales_tasks SET create_started_at=now() WHERE id=$1 AND claim_token=$2 AND lease_until>clock_timestamp() AND create_started_at IS NULL AND desired_state='open' AND NOT EXISTS (SELECT 1 FROM sog_sales_tasks prior WHERE prior.cycle_id=sog_sales_tasks.cycle_id AND prior.episode<sog_sales_tasks.episode AND prior.create_started_at IS NOT NULL AND prior.provider_completed=false)",[job.id,job.claim_token]);
   if(!claimed.rowCount)throw new InputError('task_create_guard_held',503);
   const created=await remote('/contacts/'+encodeURIComponent(job.ghl_contact_id)+'/tasks','POST',{title:'Follow up: unbooked Apprentice application',body:marker(job),dueDate:new Date(job.due_at).toISOString(),completed:false,assignedTo:opportunity.assignedTo});
   task=verifyTask(created.task,job);
   // Persist returned identity before the verification GET so failed reads recover by ID.
   await storage.query('UPDATE sog_sales_tasks SET provider_task_id=$3 WHERE id=$1 AND claim_token=$2 AND lease_until>clock_timestamp()',[job.id,job.claim_token,task.id]);
   task=await findTask({...job,provider_task_id:task.id},remote);
  }
  fresh=await owned();
  if(fresh.desired_state==='completed')throw new InputError('task_state_changed',503);
  if(task.assignedTo!==opportunity.assignedTo){
   await remote('/contacts/'+encodeURIComponent(job.ghl_contact_id)+'/tasks/'+encodeURIComponent(task.id),'PUT',{assignedTo:opportunity.assignedTo});
   task=await findTask({...job,provider_task_id:task.id},remote);
   if(task.assignedTo!==opportunity.assignedTo)throw new InputError('task_owner_unconfirmed',503);
  }
  return finish(task);
 }catch(error){
  const terminal=error instanceof InputError&&error.status===422;
  const code=error instanceof InputError&&/^task_[a-z_]+$/.test(error.message)?error.message:'task_provider_failed';
  const result=await storage.query("UPDATE sog_sales_tasks SET status=CASE WHEN $3::boolean OR attempts>=8 THEN 'review' ELSE 'pending' END,last_error=$4,available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,8)-1))::int),claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2 AND lease_until>clock_timestamp()",[job.id,job.claim_token,terminal,code]);
  return {processed:0,...(!result.rowCount?{lostLease:true}:{needsReview:terminal||job.attempts>=7,retryQueued:!terminal&&job.attempts<7})};
 }
}
module.exports={reconcileCycle,processOne,findTask,verifyTask,verifyOpportunity,marker,isUnbooked,dueHours,deadlineOrigin};
