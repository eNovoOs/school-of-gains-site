const test=require('node:test');
const assert=require('node:assert/strict');
const {processOne,reconcileCycle,findTask,marker,dueHours,deadlineOrigin}=require('../lib/sales-tasks');
const job={id:'e12c76a2-69cd-42fb-9d7a-7dd3b36ad255',cycle_id:'cycle',ghl_contact_id:'contact',ghl_opportunity_id:'opportunity',due_at:'2026-10-01T10:00:00Z',desired_state:'open',attempts:0,create_started_at:null,provider_task_id:null};
const opportunity={id:'opportunity',contactId:'contact',locationId:'3mi3YQaZvtUMZzaQUuL6',pipelineId:'GxJOcIsgv7Svx90E2BZr',status:'open',pipelineStageId:'unbooked',assignedTo:'closer000001'};
const cycle={id:'cycle',status:'open',stage:'unbooked',ghl_contact_id:'contact',ghl_opportunity_id:'opportunity',email:'media@revupcmo.com',created_at:'2026-09-30T10:00:00Z'};
const task={id:'managed-task',contactId:'contact',body:marker(job),dueDate:job.due_at,completed:false,assignedTo:'closer000001'};
function environment(t){
 const values={GHL_TASKS_ENABLED:'true',GHL_UNBOOKED_STAGE_ID:'unbooked',GHL_CLOSER_IDS:'closer000001,closer000002',ATTRIBUTION_PILOT_EMAILS:'media@revupcmo.com',GHL_TASK_DUE_HOURS:'24'};
 for(const [k,v]of Object.entries(values)){const old=process.env[k];process.env[k]=v;t.after(()=>old===undefined?delete process.env[k]:process.env[k]=old);}
}
function storage(overrides={}){
 const row={...job,...overrides};const writes=[];
 const db={transaction:fn=>fn(db),query:async(sql,args=[])=>{
  if(sql.startsWith('SELECT sc.'))return {rows:[{...cycle}],rowCount:1};
  if(sql.startsWith('SELECT * FROM sog_sales_tasks'))return {rows:[{...row}],rowCount:1};
  writes.push({sql,args});
  if(sql.includes('SET claim_token')){row.claim_token=args[1];row.attempts++;}
  if(sql.includes('SET create_started_at'))row.create_started_at=new Date();
  if(sql.includes('SET provider_task_id=$3'))row.provider_task_id=args[2];
  if(sql.includes("SET desired_state='completed'"))row.desired_state='completed';
  return {rows:[],rowCount:1};
 }};return {db,row,writes};
}
test('disabled worker and reconciliation never touch storage',async t=>{
 environment(t);process.env.GHL_TASKS_ENABLED='false';
 assert.equal((await processOne({db:{}})).disabled,true);
 assert.equal((await reconcileCycle({},'x')).disabled,true);
});
test('approved task SLA defaults to24hours and rejects a longer deadline',t=>{
 environment(t);delete process.env.GHL_TASK_DUE_HOURS;
 assert.equal(dueHours(),24);
 process.env.GHL_TASK_DUE_HOURS='25';assert.throws(()=>dueHours(),/task_due_policy_missing/);
 process.env.GHL_TASK_DUE_HOURS='';assert.throws(()=>dueHours(),/task_due_policy_missing/);
});
test('repeating an unbooked application retains episode and due date',async t=>{
 environment(t);const calls=[];
 const result=await reconcileCycle({query:async(sql,args)=>{calls.push(sql);return {rows:sql.startsWith('SELECT sc.')?[cycle]:[{id:job.id}]};}},'cycle');
 assert.deepEqual(result,{id:job.id});assert.equal(calls.length,2);
});
test('leaving unbooked requests completion without deleting any task',async t=>{
 environment(t);let update;
 await reconcileCycle({query:async(sql,args)=>{if(sql.startsWith('SELECT'))return {rows:[{...cycle,stage:'booked'}]};update={sql,args};return {}; }},'cycle');
 assert.equal(update.args[1],'superseded_by_booking');assert.match(update.sql,/desired_state='open'/);
});
test('recovery refuses unrelated, duplicate and incomplete task results',async()=>{
 assert.equal(await findTask(job,async()=>({tasks:[{...task,body:'unrelated'}]})),null);
 await assert.rejects(findTask(job,async()=>({tasks:[task,{...task,id:'second'}]})),/task_multiple_matches/);
 await assert.rejects(findTask(job,async()=>({tasks:[task],nextPage:2})),/task_list_incomplete/);
 await assert.rejects(findTask({...job,provider_task_id:task.id},async()=>({task:{...task,contactId:'other'}})),/task_identity_mismatch/);
});
test('new task commits create guard before POST and preserves frozen due date',async t=>{
 environment(t);const s=storage();let created=false;
 const result=await processOne({db:s.db,request:async(path,method='GET',body)=>{
  if(path.startsWith('/opportunities'))return {opportunity};
  if(method==='POST'){assert.ok(s.row.create_started_at);assert.equal(body.dueDate,job.due_at.replace('Z','.000Z'));created=true;return {task};}
  if(path.endsWith('/managed-task'))return {task};
  return {tasks:created?[task]:[]};
 }});
 assert.equal(result.processed,1);assert.equal(s.row.provider_task_id,task.id);
});
test('uncertain accepted create is recovered without second POST',async t=>{
 environment(t);const s=storage({create_started_at:new Date()});let writes=0;
 const result=await processOne({db:s.db,request:async(path,method='GET')=>{if(method!=='GET')writes++;return path.startsWith('/opportunities')?{opportunity}:{tasks:[task]};}});
 assert.equal(result.processed,1);assert.equal(writes,0);
 assert.ok(s.writes.some(w=>w.args[2]===task.id));
});
test('uncertain create absent from list queues recovery without another POST',async t=>{
 environment(t);const s=storage({create_started_at:new Date()});
 const result=await processOne({db:s.db,request:async(path,method='GET')=>{assert.equal(method,'GET');return path.startsWith('/opportunities')?{opportunity}:{tasks:[]};}});
 assert.equal(result.retryQueued,true);
});
test('completed by salesperson remains completed and is not recreated',async t=>{
 environment(t);const s=storage({provider_task_id:task.id});
 const result=await processOne({db:s.db,request:async(path,method='GET')=>{assert.equal(method,'GET');return path.startsWith('/opportunities')?{opportunity}:{task:{...task,completed:true}};}});
 assert.equal(result.processed,1);assert.ok(s.writes.some(w=>w.args[5]==='completed_by_salesperson'));
});
test('booking completes only exact managed task identity and verifies completion',async t=>{
 environment(t);const s=storage({provider_task_id:task.id,desired_state:'completed'});let completed=false,updates=0;
 const result=await processOne({db:s.db,request:async(path,method='GET',body)=>{
  if(path.startsWith('/opportunities'))return {opportunity:{...opportunity,pipelineStageId:'booked'}};
  assert.equal(path,'/contacts/contact/tasks/managed-task');
  if(method==='PUT'){updates++;assert.deepEqual(body,{completed:true});completed=true;return {};}
  return {task:{...task,completed}};
 }});
 assert.equal(result.processed,1);assert.equal(updates,1);
});
test('reassignment uses fresh opportunity owner and does not move due date',async t=>{
 environment(t);const s=storage({provider_task_id:task.id});let owner=task.assignedTo;
 const result=await processOne({db:s.db,request:async(path,method='GET',body)=>{
  if(path.startsWith('/opportunities'))return {opportunity:{...opportunity,assignedTo:'closer000002'}};
  if(method==='PUT'){assert.deepEqual(body,{assignedTo:'closer000002'});owner=body.assignedTo;return {};}
  return {task:{...task,assignedTo:owner}};
 }});
 assert.equal(result.processed,1);assert.equal(owner,'closer000002');
});
test('unknown opportunity owner holds for review before task mutation',async t=>{
 environment(t);const s=storage();
 const result=await processOne({db:s.db,request:async(path,method='GET')=>{assert.equal(method,'GET');return path.startsWith('/opportunities')?{opportunity:{...opportunity,assignedTo:'unknown'}}:{tasks:[]};}});
 assert.equal(result.needsReview,true);
});

test('initial deadline uses cycle creation and new episodes use their own transition time',async t=>{
 environment(t);let inserted;
 await reconcileCycle({query:async(sql,args)=>{
  if(sql.startsWith('SELECT sc.'))return {rows:[cycle]};
  if(sql.startsWith('SELECT id'))return {rows:[]};
  inserted={sql,args};return {rows:[{id:job.id}]};
 }},cycle.id);
 assert.equal(inserted.args[4],86400);assert.equal(inserted.args[5],cycle.created_at);
 assert.match(inserted.sql,/CASE WHEN MAX\(episode\) IS NULL OR \$6::timestamptz>MAX\(created_at\) THEN LEAST\(now\(\),\$6::timestamptz\) ELSE now\(\) END/);
});
test('manual deal move to setter-booked stage closes task but never moves the deal',async t=>{
 environment(t);const s=storage({provider_task_id:task.id});let completed=false;
 const mutations=[];
 const result=await processOne({db:s.db,request:async(path,method='GET',body)=>{
  if(path.startsWith('/opportunities')){assert.equal(method,'GET');return {opportunity:{...opportunity,pipelineStageId:'setter-booked'}};}
  if(method==='PUT'){mutations.push({path,body});completed=true;return {};}
  return {task:{...task,completed}};
 }});
 assert.equal(result.processed,1);assert.deepEqual(mutations,[{path:'/contacts/contact/tasks/managed-task',body:{completed:true}}]);
});
test('incomplete provider stage data holds for review instead of completing the task',async t=>{
 environment(t);const s=storage({provider_task_id:task.id});
 const result=await processOne({db:s.db,request:async(path,method='GET')=>{
  assert.equal(method,'GET');assert.match(path,/^\/opportunities/);
  return {opportunity:{...opportunity,pipelineStageId:undefined}};
 }});
 assert.equal(result.needsReview,true);
});

test('booked-first cycle cancelled days later starts its first follow-up deadline at cancellation',async t=>{
 environment(t);const cancelledAt='2026-10-04T12:30:00Z';let inserted;
 const bookedFirst={...cycle,created_at:'2026-09-30T10:00:00Z',unbooked_returned_at:cancelledAt};
 await reconcileCycle({query:async(sql,args)=>{
  if(sql.startsWith('SELECT sc.'))return {rows:[bookedFirst]};
  if(sql.startsWith('SELECT id'))return {rows:[]};
  inserted={sql,args};return {rows:[{id:job.id}]};
 }},cycle.id);
 assert.equal(inserted.args[5],cancelledAt);assert.equal(inserted.args[4],86400);
 assert.equal(new Date(Date.parse(inserted.args[5])+inserted.args[4]*1000).toISOString(),'2026-10-05T12:30:00.000Z');
});
test('initial application origin remains creation and predating cancellation cannot advance deadline',()=>{
 assert.equal(deadlineOrigin(cycle),cycle.created_at);
 assert.equal(deadlineOrigin({...cycle,unbooked_returned_at:'2026-09-01T00:00:00Z'}),cycle.created_at);
});
