const test=require('node:test');
const assert=require('node:assert/strict');
const {routingReport,LEAD_SQL,TASK_SQL,LEAD_SIGNAL_SQL}=require('../api/dashboard/stats');
test('disabled routing features issue no queries against unmigrated tables',async()=>{
 const report=await routingReport(async()=>{throw new Error('must not query');},['start','end'],{});
 assert.deepEqual(report,{leads:{enabled:false},tasks:{enabled:false},leadSignals:{enabled:false}});
});
test('lead-only reporting does not reference task table and uses the selected window',async()=>{
 const calls=[];const range=['2026-09-01','2026-10-01'];
 const report=await routingReport(async(sql,args)=>{calls.push({sql,args});return {rows:[{report:{distinctContacts:2,captures:4,pendingDeliveries:1,failedDeliveries:0}}]};},range,{LEAD_INTAKE_ENABLED:'true'});
 assert.equal(calls.length,1);assert.equal(calls[0].sql,LEAD_SQL);assert.deepEqual(calls[0].args,range);
 assert.deepEqual(report.leads,{enabled:true,distinctContacts:2,captures:4,pendingDeliveries:1,failedDeliveries:0});
 assert.deepEqual(report.tasks,{enabled:false});
});
test('task-only reporting does not reference lead tables or filter current queue by window',async()=>{
 const calls=[];
 const report=await routingReport(async(sql,args)=>{calls.push({sql,args});return {rows:[{report:{pending:3,review:1}}]};},['start','end'],{GHL_TASKS_ENABLED:'true'});
 assert.equal(calls.length,1);assert.equal(calls[0].sql,TASK_SQL);assert.equal(calls[0].args,undefined);
 assert.deepEqual(report,{leads:{enabled:false},tasks:{enabled:true,pending:3,review:1},leadSignals:{enabled:false}});
});
test('enabled reporting failure is surfaced instead of fabricating zero counts',async()=>{
 await assert.rejects(routingReport(async()=>{throw new Error('missing migration');},[],{GHL_TASKS_ENABLED:'true'}),/missing migration/);
});

test('native lead signals enable lead counts without web intake and query signal health separately',async()=>{
 const calls=[];const range=['2026-09-01','2026-10-01'];
 const report=await routingReport(async(sql,args)=>{
  calls.push({sql,args});
  return {rows:[{report:sql===LEAD_SQL?{distinctContacts:2,captures:3,pendingDeliveries:1,failedDeliveries:0}:{pending:4,failed:1}}]};
 },range,{GHL_LEAD_SIGNALS_ENABLED:'true'});
 assert.deepEqual(calls.map(c=>c.sql),[LEAD_SQL,LEAD_SIGNAL_SQL]);
 assert.deepEqual(calls[0].args,range);assert.equal(calls[1].args,undefined);
 assert.equal(report.leads.enabled,true);assert.equal(report.leads.distinctContacts,2);
 assert.deepEqual(report.leadSignals,{enabled:true,pending:4,failed:1});
 assert.deepEqual(report.tasks,{enabled:false});
});

test('lead routing reviews count current cycles independently of delivery success and selected capture window',async()=>{
 const report=await routingReport(async sql=>{
  assert.equal(sql,LEAD_SQL);
  assert.match(sql,/'reviewCycles',\(SELECT count\(\*\)::int FROM sog_lead_cycles WHERE status='review'\)/);
  return {rows:[{report:{distinctContacts:0,captures:0,pendingDeliveries:0,failedDeliveries:0,reviewCycles:3}}]};
 },['2026-10-01','2026-11-01'],{LEAD_INTAKE_ENABLED:'true'});
 assert.equal(report.leads.reviewCycles,3);assert.equal(report.leads.failedDeliveries,0);assert.equal(report.leads.captures,0);
 await assert.rejects(routingReport(async()=>{throw new Error('lead review table unavailable');},[],{LEAD_INTAKE_ENABLED:'true'}),/lead review table unavailable/);
});
