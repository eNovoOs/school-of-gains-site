const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {reissue,TTL}=require('../lib/booking-link-reissue');
const {claimFor}=require('../lib/attribution-booking');
const {bookingPath}=require('../lib/attribution-http');
const auth=require('../lib/dashboard-auth');
const LOCATION='3mi3YQaZvtUMZzaQUuL6',PIPELINE='GxJOcIsgv7Svx90E2BZr';
async function environment(fn){const prior={...process.env};Object.assign(process.env,{HANDOFF_SECRET:'h'.repeat(40),DASHBOARD_ACCESS_KEY:'a'.repeat(40),DASHBOARD_SESSION_SECRET:'s'.repeat(40),APP_ORIGIN:'https://school-of-gains.com',GHL_STAGE_IDS_JSON:JSON.stringify({unbooked:'unbooked',no_show:'no-show'})});delete process.env.ATTRIBUTION_PILOT_EMAILS;try{return await fn();}finally{for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);}}
function fixture(){
 const context={id:randomUUID(),contact_id:randomUUID(),cycle_id:randomUUID(),email:'lead@example.invalid',ghl_contact_id:'contact',ghl_opportunity_id:'opp',cycle_status:'open',cycle_stage:'unbooked',crm_status:'delivered'};
 const opportunity={id:'opp',contactId:'contact',locationId:LOCATION,pipelineId:PIPELINE,status:'open',pipelineStageId:'unbooked'};
 const state={context,opportunity,audit:null,active:false,writes:[],remoteCalls:[]};
 const query=async(sql,params)=>{
  state.writes.push({sql,params});
  if(sql.startsWith('SELECT a.id'))return {rows:state.context?[state.context]:[]};
  if(sql.startsWith('SELECT status,stage'))return {rows:[{status:context.cycle_status,stage:context.cycle_stage}]};
  if(sql.startsWith('SELECT 1 FROM sog_appointments'))return {rowCount:state.active?1:0,rows:[]};
  if(sql.startsWith('SELECT type,contact_id'))return {rows:state.audit?[state.audit]:[]};
  if(sql.startsWith('INSERT INTO sog_events'))state.audit={type:'booking_link_reissued',contact_id:params[1],payload:params[2]};
  return {rows:[]};
 };
 state.deps={db:{query,transaction:fn=>fn({query})},read:async path=>{state.remoteCalls.push(path);return path.startsWith('/contacts/')?{contact:{id:'contact',email:'lead@example.invalid',locationId:LOCATION}}:{opportunity:state.opportunity};},config:()=>({enabled:true})};
 state.input={email:'lead@example.invalid',requestId:randomUUID()};return state;
}
test('staff reissue produces bounded72-hour signed capability, logs only audit metadata, retries preserve expiry',()=>environment(async()=>{
 const f=fixture(),before=Date.now();const result=await reissue(f.input,f.deps);const claim=claimFor(new URL(result.path,'https://example.invalid').searchParams.get('ref'));
 assert.equal(claim.id,f.context.id);assert.ok(claim.expires>=before+TTL && claim.expires<=Date.now()+TTL);assert.equal(f.audit.payload.basis,'authenticated_staff');
 assert.equal(JSON.stringify(f.audit).includes('ref='),false);assert.equal(JSON.stringify(f.audit).includes('lead@example.invalid'),false);
 const duplicate=await reissue(f.input,f.deps);assert.equal(duplicate.path,result.path);assert.equal(duplicate.duplicate,true);assert.equal(f.writes.filter(x=>x.sql.startsWith('INSERT INTO sog_events')).length,1);
 const initial=claimFor(new URL(bookingPath(f.context.id),'https://example.invalid').searchParams.get('ref'));assert.ok(initial.expires<=Date.now()+3600000);
}));
test('reissue blocks won/closed/progressed, unsynced, active booking and changed remote deal identity',()=>environment(async()=>{
 for(const status of ['won','lost','review']){const f=fixture();f.context.cycle_status=status;await assert.rejects(reissue(f.input,f.deps),{message:'sales_review_required'});assert.equal(f.audit,null);}
 for(const stage of ['booked','follow_up','call_held','legacy_review']){const f=fixture();f.context.cycle_stage=stage;await assert.rejects(reissue(f.input,f.deps),{message:'sales_review_required'});}
 const pending=fixture();pending.context.crm_status='pending';await assert.rejects(reissue(pending.input,pending.deps),{message:'contact_sync_pending'});
 const active=fixture();active.active=true;await assert.rejects(reissue(active.input,active.deps),{message:'appointment_already_exists'});
 for(const change of [{status:'won'},{contactId:'other'},{pipelineId:'other'},{locationId:'other'},{pipelineStageId:'booked'}]){const f=fixture();Object.assign(f.opportunity,change);await assert.rejects(reissue(f.input,f.deps),{message:'sales_review_required'});assert.equal(f.audit,null);}
}));
test('reissue does not create an application for native-only contacts or accept mismatched retry identity',()=>environment(async()=>{
 const f=fixture();f.context=null;await assert.rejects(reissue(f.input,f.deps),{message:'application_not_found'});assert.equal(f.audit,null);
 const collision=fixture();collision.audit={type:'booking_link_reissued',contact_id:'another',payload:{}};await assert.rejects(reissue(collision.input,collision.deps),{message:'idempotency_conflict'});
 const disabled=fixture();disabled.deps.config=()=>({enabled:false});await assert.rejects(reissue(disabled.input,disabled.deps),{message:'booking_unavailable'});
}));
test('capability expires rather than silently refreshing; excessive or expired TTL is rejected',()=>environment(async()=>{
 const f=fixture(),result=await reissue(f.input,f.deps),token=new URL(result.path,'https://example.invalid').searchParams.get('ref');
 const clock=Date.now;Date.now=()=>Date.parse(result.expiresAt)+1;
 try{assert.throws(()=>claimFor(token),{message:'handoff_expired'});await assert.rejects(reissue(f.input,f.deps),{message:'reissue_expired'});}finally{Date.now=clock;}
 assert.throws(()=>bookingPath(f.context.id,Date.now()+TTL+10000),{message:'invalid_handoff_expiry'});
}));
test('staff endpoint rejects unauthenticated, cross-origin, wrong method and non-JSON calls before lookup',()=>environment(async()=>{
 const handler=require('../api/dashboard/booking-link');let cookie;auth.setSession({setHeader:(name,value)=>{cookie=value.split(';')[0];}});
 const invoke=async req=>{let status;const res={setHeader(){},status(value){status=value;return this;},json(){}};await handler(req,res);return status;};
 const headers={cookie,origin:'https://school-of-gains.com','content-type':'application/json'};
 assert.equal(await invoke({method:'POST',headers:{origin:headers.origin}}),401);
 assert.equal(await invoke({method:'POST',headers:{...headers,origin:'https://attacker.invalid'}}),403);
 assert.equal(await invoke({method:'GET',headers}),405);
 assert.equal(await invoke({method:'POST',headers:{...headers,'content-type':'text/plain'}}),415);
}));
