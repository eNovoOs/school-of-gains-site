const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const config=require('../vercel.json');
test('every durable CRM queue has exactly one scheduled authenticated worker endpoint',()=>{
 const required=['/api/webhooks/process','/api/webhooks/process-signals','/api/webhooks/process-leads','/api/webhooks/process-tasks','/api/webhooks/recover-bookings'];
 for(const route of required){
  const scheduled=config.crons.filter(job=>job.path===route);assert.equal(scheduled.length,1,route+' must be scheduled once');
  assert.equal(scheduled[0].schedule,'* * * * *');
  const file=route.slice(1)+'.js';assert.ok(config.functions[file]?.maxDuration>=60);
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  assert.match(source,/authorize\(req,'CRON_SECRET'\)/);assert.match(source,/['"]GET['"]/);
 }
});
