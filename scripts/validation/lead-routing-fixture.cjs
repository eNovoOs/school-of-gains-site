const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {lead,saveLead}=require('../../lib/lead-intake');
const {application}=require('../../lib/attribution');
const {reconcileCycle}=require('../../lib/sales-tasks');

// Only the disposable PostgreSQL harness calls this fixture. No provider workers
// run: tasks are reconciled locally and external HTTP is explicitly forbidden.
module.exports=async function validateLeadRouting(db){
 const schema=(await db.query('SELECT current_schema() AS name')).rows[0].name;
 assert.match(schema,/^sog_test_[0-9a-f]{32}$/,'Lead routing fixture requires a disposable validation schema');
 const envKeys=['GHL_TASKS_ENABLED','GHL_TASK_DUE_HOURS'],originalEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]])),originalFetch=global.fetch;
 const checks=[];
 process.env.GHL_TASKS_ENABLED='true';process.env.GHL_TASK_DUE_HOURS='1';
 global.fetch=async()=>{throw new Error('External HTTP is prohibited during lead routing validation');};
 try{
  const email='lead-routing-'+randomUUID()+'@example.invalid';
  const input=lead({submissionId:randomUUID(),journeyId:randomUUID(),offer:'community',contact:{email,firstName:'Routing Fixture'},consent:{privacy:true,marketing:false},attribution:{utm_source:'meetup',utm_medium:'offline'}});
  const results=await Promise.all(Array.from({length:8},()=>saveLead(input,{db})));
  assert.equal(results.filter(result=>result.duplicate===false).length,1);
  assert.equal(results.filter(result=>result.duplicate===true).length,7);
  const {rows:contacts}=await db.query('SELECT * FROM sog_contacts WHERE email=$1',[email]);assert.equal(contacts.length,1);
  const contact=contacts[0];
  for(const table of ['sog_lead_captures','sog_lead_cycles'])assert.equal((await db.query('SELECT count(*)::int AS n FROM '+table+' WHERE contact_id=$1',[contact.id])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_outbox WHERE event_id=$1',[input.submissionId])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_events WHERE event_id=$1',[input.submissionId])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_sales_cycles WHERE contact_id=$1',[contact.id])).rows[0].n,0);
  checks.push('concurrent duplicate lead capture creates one canonical contact, capture, prospect cycle, event and outbox job');

  const offers=['newsletter','free_lessons','free_tools','webinar'];
  await Promise.all(offers.map(offer=>saveLead(lead({...input,submissionId:randomUUID(),journeyId:randomUUID(),offer,attribution:{utm_source:'youtube',utm_medium:'organic_social'}}),{db})));
  const {rows:leadCycles}=await db.query('SELECT * FROM sog_lead_cycles WHERE contact_id=$1',[contact.id]);
  assert.equal(leadCycles.length,1);assert.equal(leadCycles[0].entry_offer,'community');
  const {rows:[afterOffers]}=await db.query('SELECT * FROM sog_contacts WHERE email=$1',[email]);
  assert.equal(afterOffers.id,contact.id);assert.deepEqual(afterOffers.first_touch,contact.first_touch);assert.equal(afterOffers.latest_touch.source,'youtube');
  const captures=(await db.query('SELECT * FROM sog_lead_captures WHERE contact_id=$1',[contact.id])).rows;
  assert.equal(captures.length,5);assert.equal(new Set(captures.map(row=>row.lead_cycle_id)).size,1);
  assert.deepEqual(captures.map(row=>row.offer).sort(),['community',...offers].sort());
  assert.ok(captures.every(row=>row.attribution.firstTouch.source==='meetup'));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sog_outbox WHERE type='lead' AND payload->>'contactId'=$1",[contact.id])).rows[0].n,5);
  checks.push('multiple offers retain one prospect cycle and original first touch while recording separate captures');

  const quiz=application({submissionId:randomUUID(),journeyId:randomUUID(),quizVersion:'apprentice-v1',contact:{email,firstName:'Routing Fixture'},consent:{privacy:true,marketing:false},answers:{ageRange:'30_39',goals:['build_system'],weeklyTime:'3_5_hours',educationBudget:'not_ready',attendance:'unsure'},attribution:{utm_source:'google',utm_medium:'cpc'}});
  await db.saveApplication(quiz);
  const {rows:[app]}=await db.query('SELECT * FROM sog_applications WHERE id=$1',[quiz.submissionId]);
  assert.equal(app.contact_id,contact.id);assert.equal(app.attribution.firstTouch.source,'meetup');
  const {rows:salesCycles}=await db.query('SELECT * FROM sog_sales_cycles WHERE contact_id=$1',[contact.id]);
  assert.equal(salesCycles.length,1);assert.equal(salesCycles[0].stage,'unbooked');assert.equal(salesCycles[0].id,app.cycle_id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_contacts WHERE email=$1',[email])).rows[0].n,1);
  assert.equal((await db.query('SELECT first_touch FROM sog_contacts WHERE id=$1',[contact.id])).rows[0].first_touch.source,'meetup');
  checks.push('qualification application reuses canonical lead contact and creates one unbooked sales cycle');

  const cycleId=app.cycle_id;
  await db.query('UPDATE sog_contacts SET ghl_contact_id=$2 WHERE id=$1',[contact.id,'fixture-contact-'+randomUUID()]);
  await db.query('UPDATE sog_sales_cycles SET ghl_opportunity_id=$2,assigned_closer_id=$3 WHERE id=$1',[cycleId,'fixture-opportunity-'+randomUUID(),'fixture-closer']);
  const reconcile=()=>db.transaction(c=>reconcileCycle(c,cycleId));
  await Promise.all(Array.from({length:8},reconcile));
  const readTasks=async()=> (await db.query('SELECT * FROM sog_sales_tasks WHERE cycle_id=$1 ORDER BY episode',[cycleId])).rows;
  let tasks=await readTasks();assert.equal(tasks.length,1);assert.equal(tasks[0].episode,1);assert.equal(tasks[0].desired_state,'open');
  const originalTask=tasks[0],originalDue=new Date(originalTask.due_at).toISOString();
  assert.ok(Math.abs(new Date(originalTask.due_at)-new Date(originalTask.created_at)-3600000)<1000,'Fixture due time follows the explicitly configured one-hour policy');
  await Promise.all(Array.from({length:4},reconcile));
  tasks=await readTasks();assert.equal(tasks.length,1);assert.equal(tasks[0].id,originalTask.id);assert.equal(new Date(tasks[0].due_at).toISOString(),originalDue);
  checks.push('concurrent and repeated unbooked reconciliation creates one task episode without resetting its due time');

  await db.transaction(async c=>{await c.query("UPDATE sog_sales_cycles SET stage='booked' WHERE id=$1",[cycleId]);await reconcileCycle(c,cycleId);});
  tasks=await readTasks();assert.equal(tasks.length,1);assert.equal(tasks[0].desired_state,'completed');assert.equal(tasks[0].completion_reason,'superseded_by_booking');assert.equal(tasks[0].status,'pending');
  assert.equal(tasks[0].provider_task_id,null); // This fixture never sends to GHL.
  await db.transaction(async c=>{await c.query("UPDATE sog_sales_cycles SET stage='unbooked' WHERE id=$1",[cycleId]);await reconcileCycle(c,cycleId);});
  await Promise.all(Array.from({length:4},reconcile));
  tasks=await readTasks();assert.equal(tasks.length,2);assert.deepEqual(tasks.map(row=>row.episode),[1,2]);assert.deepEqual(tasks.map(row=>row.desired_state),['completed','open']);
  assert.notEqual(tasks[0].id,tasks[1].id);assert.equal(new Date(tasks[0].due_at).toISOString(),originalDue);assert.ok(tasks.every(row=>row.provider_task_id===null));
  checks.push('booking completes the first local task episode and renewed unbooked status creates exactly one new episode');
  return checks;
 }finally{
  global.fetch=originalFetch;
  for(const key of envKeys)if(originalEnv[key]===undefined)delete process.env[key];else process.env[key]=originalEnv[key];
 }
};
