const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {saveAppointmentInTransaction}=require('../lib/attribution-db');
const {syncAppointment}=require('../lib/attribution-ghl');
const {ATTR_FIELDS}=require('../lib/lead-ghl');
const creation=require('../lib/opportunity-creation');
const LOCATION='3mi3YQaZvtUMZzaQUuL6',CLOSERS='GxJOcIsgv7Svx90E2BZr';
const stages={booked:'booked',booked_ads:'ads',booked_setter:'setter',unbooked:'unbooked',call_held:'held',follow_up:'follow',contacted_once:'once',won:'won'};
test('confirmed appointment without application creates a sales cycle and routing job, never quiz data',async()=>{
 const writes=[],contact={id:randomUUID(),ghl_contact_id:'contact',first_touch:{source:'meetup'},latest_touch:{source:'youtube'}};
 const c={query:async(sql,params)=>{writes.push({sql,params});if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[contact]};if(sql.startsWith('INSERT INTO sog_sales_cycles'))return {rows:[{id:params[0],contact_id:contact.id,status:params[2],stage:params[3]}]};return {rows:[],rowCount:0};}};
 await saveAppointmentInTransaction(c,{eventId:randomUUID(),appointmentId:'booking',contactId:'contact',calendarId:'calendar',status:'confirmed',startsAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 const cycle=writes.find(x=>x.sql.startsWith('INSERT INTO sog_sales_cycles'));assert.ok(cycle);assert.equal(cycle.params[3],'booked');
 const appt=writes.find(x=>x.sql.startsWith('INSERT INTO sog_appointments'));assert.equal(appt.params[2],cycle.params[0]);
 assert.equal(writes.find(x=>x.sql.startsWith('INSERT INTO sog_outbox')).params[2].cycleId,cycle.params[0]);
 assert.equal(writes.some(x=>x.sql.includes('INSERT INTO sog_applications')),false);
});
test('negative appointment alone does not create a sales cycle',async()=>{
 for(const status of ['cancelled','invalid','noshow']){
  const queries=[];const c={query:async(sql)=>{queries.push(sql);return {rows:sql.startsWith('SELECT * FROM sog_contacts')?[{id:randomUUID()}]:[],rowCount:0};}};
  await saveAppointmentInTransaction(c,{eventId:randomUUID(),appointmentId:'booking',contactId:'contact',status,updatedAt:new Date().toISOString()});
  assert.equal(queries.some(sql=>sql.startsWith('INSERT INTO sog_sales_cycles')),false);
 }
});
async function fixture({opportunities=[],reserve=true,contactOverride={},stage='booked',postError=false,knownDeal,meta}={}){
 const env={...process.env},fetch=global.fetch,calls=[],writes=[],cycle={id:randomUUID(),contact_id:randomUUID(),status:'open',stage};
 Object.assign(process.env,{GHL_SYNC_ENABLED:'true',GHL_PRIVATE_INTEGRATION_TOKEN:'test',GHL_STAGE_IDS_JSON:JSON.stringify(stages),GHL_ATTRIBUTION_FIELDS_JSON:JSON.stringify(Object.fromEntries(ATTR_FIELDS.map(key=>[key,key])))});
 global.fetch=async(url,options)=>{
  const path=new URL(url).pathname;const data=options.body&&JSON.parse(options.body);calls.push({path,method:options.method,data});
  if(path==='/contacts/contact')return {ok:true,json:async()=>({contact:{id:'contact',locationId:LOCATION,email:'booking@example.invalid',...contactOverride}})};
  const searchedDeal=opportunities.find(o=>path==='/opportunities/'+o.id);
  if(searchedDeal && !knownDeal)return {ok:true,json:async()=>({opportunity:searchedDeal})};
  if(knownDeal && path==='/opportunities/'+knownDeal.id)return {ok:true,json:async()=>({opportunity:knownDeal})};
  if(path==='/opportunities/search')return {ok:true,json:async()=>({opportunities,meta})};
  if(options.method==='POST') {if(postError)throw new Error('timeout');return {ok:true,json:async()=>({opportunity:{id:'new-deal',locationId:LOCATION,contactId:'contact',pipelineId:CLOSERS,pipelineStageId:data.pipelineStageId,status:'open',assignedTo:data.assignedTo}})};}
  return {ok:true,json:async()=>({})};
 };
 const c={query:async(sql,params)=>{writes.push({sql,params});if(sql.startsWith('SELECT * FROM sog_sales_cycles'))return {rows:[cycle]};if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[{id:cycle.contact_id,email:'booking@example.invalid',ghl_contact_id:'contact',first_touch:{source:'meetup'},latest_touch:{source:'google',medium:'cpc'}}]};if(sql.startsWith('SELECT ghl_opportunity_id FROM sog_lead_cycles'))return {rows:knownDeal?[{ghl_opportunity_id:knownDeal.id}]:[]};if(sql.startsWith('SELECT booking_setter_id'))return {rows:[{attribution:{latestTouch:{medium:'cpc'}}}]};return {rows:[]};}};
 try{await syncAppointment(c,{cycleId:cycle.id},{reserveCloser:async()=>{calls.push({method:'ALLOCATE'});return 'reserved-closer';},reserveCreation:async()=>reserve});return {calls,writes,cycle};}
 catch(error){error.calls=calls;throw error;}
 finally{global.fetch=fetch;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
}
test('booking-only sync verifies contact and creates assigned ads deal without fabricating quiz/consent',async()=>{
 const {calls,writes}=await fixture();const post=calls.find(x=>x.method==='POST');assert.equal(post.data.pipelineStageId,'ads');assert.equal(post.data.assignedTo,'reserved-closer');assert.equal(post.data.pipelineId,CLOSERS);
 const update=calls.find(x=>x.method==='PUT' && x.path==='/contacts/contact').data;
 assert.deepEqual(update.customFields.map(x=>x.id).sort(),[...ATTR_FIELDS].sort());assert.equal(writes.some(x=>x.sql.includes('sog_applications')),false);
});
test('existing closer ownership and progressed column survive booking adoption',async()=>{
 const opportunity={id:'existing',contactId:'contact',pipelineId:CLOSERS,pipelineStageId:'once',status:'open',assignedTo:'existing-owner'};
 const {calls,writes,cycle}=await fixture({opportunities:[opportunity]});assert.equal(calls.some(x=>['POST','PUT','ALLOCATE'].includes(x.method)),false);assert.equal(cycle.stage,'follow_up');
 assert.equal(writes.find(x=>x.sql.includes('assigned_closer_id')).params[2],'existing-owner');
});
test('won customer is sent to review without another deal; uncertain creation and identity mismatch never POST',async()=>{
 const result=await fixture({opportunities:[{id:'won',contactId:'contact',pipelineId:CLOSERS,status:'won'}]});assert.ok(result.writes.some(x=>x.sql.includes("status='review'")));assert.equal(result.calls.some(x=>x.method==='POST'),false);
 for(const [options,message] of [[{reserve:false},'ghl_opportunity_creation_uncertain_review_required'],[{contactOverride:{email:'someone-else@example.invalid'}},'ghl_contact_identity_review_required'],[{opportunities:[{id:'wrong',contactId:'wrong',pipelineId:CLOSERS,status:'open'}]},'ghl_opportunity_review_required']]){
  await assert.rejects(fixture(options),error=>{assert.equal(error.message,message);assert.equal(error.calls.some(x=>x.method==='POST'),false);return true;});
 }
});
test('independent durable creation fence authorizes exactly one POST attempt and detects changed identity',async()=>{
 const id=randomUUID();let saved;
 const run=async fn=>fn({query:async(sql,params)=>{if(sql.startsWith('INSERT')){if(saved)return {rowCount:0};saved=params[1];return {rowCount:1};}return {rows:[{ghl_contact_id:saved}]};}});
 assert.equal(await creation.reserve(id,'contact',run),true);assert.equal(await creation.reserve(id,'contact',run),false);await assert.rejects(creation.reserve(id,'other',run),{message:'ghl_opportunity_creation_identity_invalid'});
});


test('setter handoff column plus real booking creates separate closer deal and leaves setter untouched',async()=>{
 const setter={id:'setter-deal',contactId:'contact',pipelineId:'PSq0fv77HbtMg9bdKC2p',pipelineStageId:'2f75b70e-62fd-4b31-a72f-381f2a505165',status:'open',assignedTo:'setter-person'};
 await assert.rejects(fixture({opportunities:[setter],stage:'unbooked'}),{message:'ghl_active_booking_missing'});
 const result=await fixture({opportunities:[setter]});
 const post=result.calls.find(call=>call.method==='POST');assert.equal(post.data.pipelineStageId,'setter');assert.equal(post.data.assignedTo,'reserved-closer');
 assert.equal(result.calls.some(call=>call.path==='/opportunities/setter-deal'&&call.method!=='GET'),false);
 assert.equal(result.writes.some(write=>write.sql.includes('booking_setter_id=')),false);
 await assert.rejects(fixture({opportunities:[setter],reserve:false}),error=>{assert.equal(error.message,'ghl_opportunity_creation_uncertain_review_required');assert.equal(error.calls.some(call=>call.method==='POST'),false);return true;});
 const existing={id:'closer-deal',contactId:'contact',pipelineId:CLOSERS,pipelineStageId:'setter',status:'open',assignedTo:'retained-owner'};
 const retry=await fixture({opportunities:[setter,existing]});assert.equal(retry.cycle.ghl_opportunity_id,'closer-deal');assert.equal(retry.calls.some(call=>call.method==='POST'),false);
 assert.equal(retry.writes.find(write=>write.sql.includes('assigned_closer_id')).params[2],'retained-owner');
});
test('wrong setter stage waits; exact read overrides stale search handoff stage',async()=>{
 const setter={id:'setter-deal',contactId:'contact',pipelineId:'PSq0fv77HbtMg9bdKC2p',pipelineStageId:'2f75b70e-62fd-4b31-a72f-381f2a505165',status:'open',assignedTo:'setter-person'};
 for(const options of [{opportunities:[{...setter,pipelineStageId:'original'}]},{opportunities:[setter],knownDeal:{...setter,pipelineStageId:'original'}}]){
  await assert.rejects(fixture(options),error=>{assert.equal(error.message,'ghl_manual_setter_transfer_pending');assert.equal(error.calls.some(call=>['POST','PUT','ALLOCATE'].includes(call.method)),false);return true;});
 }
});

test('GHL terminal search cursor URL does not block a complete handoff result',async()=>{
 const setter={id:'setter-deal',contactId:'contact',pipelineId:'PSq0fv77HbtMg9bdKC2p',pipelineStageId:'2f75b70e-62fd-4b31-a72f-381f2a505165',status:'open'};
 const meta={total:1,currentPage:1,nextPage:'',nextPageUrl:'https://services.leadconnectorhq.com/opportunities/search?startAfterId=setter-deal'};
 const result=await fixture({opportunities:[setter],meta});
 assert.equal(result.calls.find(x=>x.method==='POST').data.pipelineStageId,'setter');
 for(const incomplete of [{...meta,total:2},{...meta,total:undefined},{...meta,nextPage:2}]){
  await assert.rejects(fixture({opportunities:[setter],meta:incomplete}),e=>{assert.equal(e.message,'ghl_opportunity_review_required');assert.equal(e.calls.some(x=>x.method==='POST'),false);return true;});
 }
});
