const test=require('node:test');
const assert=require('node:assert/strict');
const {lifecycleStage,bookingStage,protectsProgress}=require('../lib/pipeline-routing');
const {syncAppointment}=require('../lib/attribution-ghl');
const stages={unbooked:'unbooked',booked:'booked',booked_ads:'ads',booked_setter:'setter',booked_closer:'closer',no_show:'no-show',call_held:'held',follow_up:'follow',contacted_once:'once',contacted_twice:'twice',future_follow_up:'future',won:'won',lost:'lost'};
test('all booking and progressed GHL columns map to safe canonical lifecycle states',()=>{
 for(const id of ['ads','setter','closer','booked'])assert.equal(lifecycleStage(stages,id),'booked');
 for(const id of ['once','twice','future','follow'])assert.equal(lifecycleStage(stages,id),'follow_up');
 assert.equal(lifecycleStage(stages,'unknown'),undefined);
});
test('booking classification separates paid acquisition from verified booking setter credit',()=>{
 const paid={attribution:{latestTouch:{medium:'paid_social'}}};
 assert.equal(bookingStage(stages,'unbooked',paid),'booked_ads');
 assert.equal(bookingStage(stages,'unbooked',{...paid,booking_setter_id:'verified-setter'}),'booked_setter');
 assert.equal(bookingStage(stages,'unbooked',{assignedUserId:'closer',attribution:{latestTouch:{source:'facebook',fbclid:'click',bookingSetterId:'forged'}}}),'booked');
 assert.equal(bookingStage(stages,'unbooked',{attribution:{firstTouch:{medium:'cpc'},latestTouch:{medium:'organic_social'}}}),'booked');
 for(const [id,key] of [['setter','booked_setter'],['closer','booked_closer'],['ads','booked_ads']])assert.equal(bookingStage(stages,id,paid),key);
});
test('later sales progress and terminal columns resist appointment regressions',()=>{
 for(const remote of ['call_held','follow_up','won','lost'])for(const target of ['booked','unbooked','no_show'])assert.equal(protectsProgress(remote,target),true);
 assert.equal(protectsProgress('no_show','booked'),false);
});
async function runSync({stage='booked',remote='unbooked',appointment={attribution:{latestTouch:{medium:'cpc'}}},mapping=stages,remoteStatus='open'}) {
 const priorFetch=global.fetch,priorEnv={...process.env},requests=[],queries=[];
 Object.assign(process.env,{GHL_SYNC_ENABLED:'true',GHL_PRIVATE_INTEGRATION_TOKEN:'test',GHL_STAGE_IDS_JSON:JSON.stringify(mapping)});
 global.fetch=async(url,options)=>{requests.push({url,method:options.method,body:options.body&&JSON.parse(options.body)});return {ok:true,json:async()=>({opportunities:[],opportunity:{id:'opp',pipelineId:'GxJOcIsgv7Svx90E2BZr',status:remoteStatus,pipelineStageId:remote}})};};
 const c={query:async(sql,params)=>{queries.push({sql,params});return {rows:sql.startsWith('SELECT * FROM sog_contacts')?[{id:'contact',ghl_contact_id:'ghl-contact'}]:sql.startsWith('SELECT ghl_opportunity_id')?[]:sql.startsWith('SELECT * FROM sog_sales_cycles')?[{id:'cycle',status:'open',stage,ghl_opportunity_id:'opp',booking_setter_id:'stale-cycle-setter'}]:appointment?[appointment]:[]};}};
 try{await syncAppointment(c,{cycleId:'cycle',appointmentId:'stale-job-appointment'});return {requests,queries};}
 finally{global.fetch=priorFetch;for(const key of Object.keys(process.env))if(!(key in priorEnv))delete process.env[key];Object.assign(process.env,priorEnv);}
}
test('appointment sync routes paid active snapshot to ads and does not reuse stale cycle setter',async()=>{
 const result=await runSync({});assert.equal(result.requests.find(r=>r.method==='PUT').body.pipelineStageId,'ads');
 assert.match(result.queries[1].sql,/status IN \('new','confirmed'\)/);assert.deepEqual(result.queries[1].params,['cycle']);
});
test('verified setter sync routes setter column; reschedule preserves existing closer column',async()=>{
 const setter=await runSync({appointment:{booking_setter_id:'verified'}});assert.equal(setter.requests[1].body.pipelineStageId,'setter');
 const closer=await runSync({remote:'closer'});assert.equal(closer.requests.length,1);
});
test('cancellation/no-show/attendance leave BOF for lifecycle column but cannot regress contacted stages',async()=>{
 for(const [stage,id] of [['unbooked','unbooked'],['no_show','no-show'],['call_held','held']]) {
  const result=await runSync({stage,remote:'setter',appointment:null});assert.equal(result.requests[1].body.pipelineStageId,id);
 }
 for(const remote of ['once','twice','future','held','won','lost'])assert.equal((await runSync({remote})).requests.length,1);
});
test('missing attribution routing configuration or active booking fails without stage write',async()=>{
 const incomplete={...stages};delete incomplete.booked_ads;
 await assert.rejects(runSync({mapping:incomplete}),{message:'ghl_stage_mapping_missing'});
 await assert.rejects(runSync({appointment:null}),{message:'ghl_active_booking_missing'});
 await assert.rejects(runSync({remote:'unknown'}),{message:'ghl_remote_stage_unmapped'});
});
