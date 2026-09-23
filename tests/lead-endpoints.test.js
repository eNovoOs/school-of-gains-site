const test=require('node:test');const assert=require('node:assert/strict');
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.value=v;return this;}};}
test('lead endpoint rejects disabled intake before storage or provider calls',async()=>{
 const old=process.env.LEAD_INTAKE_ENABLED;delete process.env.LEAD_INTAKE_ENABLED;
 try{const res=response();await require('../api/leads')({method:'POST',headers:{},body:{}},res);assert.equal(res.code,503);assert.equal(res.value.error,'lead_intake_unavailable');}finally{if(old===undefined)delete process.env.LEAD_INTAKE_ENABLED;else process.env.LEAD_INTAKE_ENABLED=old;}
});
test('task worker requires authentication and explicit activation',async()=>{
 const previous={...process.env};process.env.CRON_SECRET='x'.repeat(40);delete process.env.GHL_TASKS_ENABLED;
 try{let res=response();await require('../api/webhooks/process-tasks')({method:'POST',headers:{}},res);assert.equal(res.code,401);res=response();await require('../api/webhooks/process-tasks')({method:'POST',headers:{authorization:'Bearer '+process.env.CRON_SECRET}},res);assert.equal(res.code,503);assert.equal(res.value.error,'tasks_disabled');}finally{for(const key of ['CRON_SECRET','GHL_TASKS_ENABLED'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});
test('terminal appointment updates do not undo a progressed closer stage',()=>{
 const {nextStage}=require('../lib/attribution');for(const stage of ['call_held','follow_up'])for(const status of ['cancelled','invalid','noshow'])assert.equal(nextStage({status:'open',stage},status),stage);
});
