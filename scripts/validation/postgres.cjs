#!/usr/bin/env node
// Destructive only to its own randomly named schema; never uses DATABASE_URL.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
function safetyConfiguration(argv,env) {
  if(env.SOG_ALLOW_SCHEMA_TESTS!=='YES_DISPOSABLE_DATABASE')throw new Error('Set SOG_ALLOW_SCHEMA_TESTS=YES_DISPOSABLE_DATABASE after verifying the target is disposable.');
  if(!env.SOG_TEST_DATABASE_URL)throw new Error('SOG_TEST_DATABASE_URL is required; DATABASE_URL is never used as a fallback.');
  let url;try{url=new URL(env.SOG_TEST_DATABASE_URL);}catch{throw new Error('Invalid test database URL.');}
  if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Test URL must use PostgreSQL.');
  const database=decodeURIComponent(url.pathname.slice(1));
  if(!database || !argv.includes('--confirm-disposable-database='+database))throw new Error('Pass --confirm-disposable-database=<exact database name> after verifying the test target.');
  const schema='sog_test_'+randomUUID().replaceAll('-','');
  const isolated=new URL(url);isolated.searchParams.set('options','-c search_path='+schema+' -c statement_timeout=15000 -c lock_timeout=10000');
  return {baseUrl:url.toString(),isolatedUrl:isolated.toString(),database,schema};
}
async function run(argv=process.argv.slice(2),env=process.env) {
  const config=safetyConfiguration(argv,env);
  const {Pool}=require('pg');
  const admin=new Pool({connectionString:config.baseUrl,max:1,connectionTimeoutMillis:10000});
  let created=false,db,allocation,migrationConnection;
  const originalFetch=global.fetch;
  const originalEnv={...process.env};
  const checks=[];
  const check=(name)=>{checks.push(name);process.stdout.write('PASS '+name+'\n');};
  try {
    const {rows:[target]}=await admin.query('SELECT current_database() AS name');
    assert.equal(target.name,config.database,'Connected database does not match confirmation');
    // schema is generated here, never taken from argv or an environment variable.
    assert.match(config.schema,/^sog_test_[0-9a-f]{32}$/);
    await admin.query('CREATE SCHEMA "'+config.schema+'"');created=true;
    process.env.DATABASE_URL=config.isolatedUrl;
    process.env.GHL_SYNC_ENABLED='false';process.env.GHL_BOOKING_ENABLED='false';
    delete process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
    global.fetch=async()=>{throw new Error('External HTTP is prohibited during database validation');};
    db=require('../../lib/attribution-db');
    allocation=require('../../lib/attribution-assignment');
    assert.equal((await db.query('SELECT current_schema() AS name')).rows[0].name,config.schema,'Runtime pool is not isolated');
    migrationConnection=await db.getPool().connect();
    for(let pass=0;pass<2;pass++)for(const file of ['001-attribution.sql','002-booking.sql','003-closer-rotation.sql','004-provider-signals.sql','005-booking-recovery.sql']) {
      assert.equal((await migrationConnection.query('SELECT current_schema() AS name')).rows[0].name,config.schema);
      await migrationConnection.query(await fs.readFile(path.join(__dirname,'../../db',file),'utf8'));
    }
    migrationConnection.release();migrationConnection=null;
    const {rows:tables}=await db.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1',[config.schema]);
    assert.equal(tables.length,12);
    check('migrations 001–005 apply and reapply inside disposable schema');
    if(argv.includes('--recovery-only')) {
      await require('./booking-recovery-fixture.cjs')(db);
      check('recovery concurrency, lease fencing, moved booking and cancellation persist atomically');
      process.stdout.write(JSON.stringify({ok:true,checks:checks.length,providerWrites:0,scope:'random disposable schema',focus:'recovery'})+'\n');
      return;
    }
    if(argv.includes('--outbox-only')) {
      const contactId=randomUUID(),cycleId=randomUUID(),eventId=randomUUID();
      await db.query("INSERT INTO sog_contacts(id,email,first_touch,latest_touch) VALUES($1,'outbox-test@example.invalid','{}','{}')",[contactId]);
      await db.query("INSERT INTO sog_sales_cycles(id,contact_id,status,stage) VALUES($1,$2,'open','unbooked')",[cycleId,contactId]);
      await db.query("INSERT INTO sog_events(event_id,type,payload) VALUES($1,'quiz_submitted','{}')",[eventId]);
      await db.query("INSERT INTO sog_outbox(event_id,type,payload) VALUES($1,'application','{}')",[eventId]);
      await require('./outbox-failure-fixture.cjs')(db,cycleId);
      check('outbox SQL errors persist all ten attempts while delivery writes roll back');
      process.stdout.write(JSON.stringify({ok:true,checks:checks.length,providerWrites:0,scope:'random disposable schema',focus:'outbox'})+'\n');
      return;
    }
    const {application}=require('../../lib/attribution');
    const form=(email,source='meetup')=>application({submissionId:randomUUID(),journeyId:randomUUID(),quizVersion:'apprentice-v1',contact:{email,firstName:'Database Test'},consent:{privacy:true,marketing:false},answers:{ageRange:'30_39',goals:['build_system'],weeklyTime:'3_5_hours',educationBudget:'not_ready',attendance:'unsure'},attribution:{utm_source:source,utm_medium:'offline'}});
    const input=form('postgres-validation@example.invalid');
    const duplicates=await Promise.all(Array.from({length:10},()=>db.saveApplication(input)));
    assert.equal(duplicates.filter(x=>!x.duplicate).length,1);
    for(const table of ['sog_contacts','sog_applications','sog_sales_cycles','sog_events','sog_outbox'])assert.equal(Number((await db.query('SELECT count(*) AS n FROM '+table)).rows[0].n),1);
    assert.equal((await db.query('SELECT stage FROM sog_sales_cycles')).rows[0].stage,'unbooked');
    check('concurrent duplicate intake creates one contact, application, cycle, event and outbox job');
    await assert.rejects(db.saveApplication({...input,contact:{...input.contact,email:'another@example.invalid'}}),{message:'idempotency_conflict'});
    await Promise.all(Array.from({length:6},()=>db.saveApplication(form(input.contact.email,'google'))));
    const {rows:[contact]}=await db.query('SELECT * FROM sog_contacts');
    const {rows:[cycle]}=await db.query('SELECT * FROM sog_sales_cycles');
    assert.equal(contact.first_touch.source,'meetup');assert.equal(contact.latest_touch.source,'google');
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM sog_sales_cycles')).rows[0].n),1);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM sog_applications')).rows[0].n),7);
    check('repeat applications preserve first attribution and reuse one open cycle');
    // Exercise the genuine independent allocator pool while outbox-like row locks
    // hold every main-pool connection, detecting nested-pool starvation/deadlocks.
    const closerIds=['BCR448vrYnQHOwub4MEd','Rt4YE2nRGqKHwKkq2jVo'];
    const allocationCycles=Array.from({length:10},()=>randomUUID());
    const owners=await Promise.all(allocationCycles.map(id=>allocation.reserveCloser(id,closerIds)));
    const counts=closerIds.map(id=>owners.filter(x=>x===id).length);assert.deepEqual(counts,[5,5]);
    const originalOwner=owners[0];
    assert.ok((await Promise.all(Array.from({length:8},()=>allocation.reserveCloser(allocationCycles[0],closerIds)))).every(x=>x===originalOwner));
    assert.equal(Number((await db.query('SELECT next_position FROM sog_closer_rotation')).rows[0].next_position),10);
    await allocation.closeAllocationPool();
    assert.equal(await allocation.reserveCloser(allocationCycles[0],[...closerIds].reverse()),originalOwner);
    assert.equal(Number((await db.query('SELECT next_position FROM sog_closer_rotation')).rows[0].next_position),10);
    await Promise.all(Array.from({length:3},()=>db.transaction(async c=>{await c.query('SELECT id FROM sog_sales_cycles WHERE id=$1 FOR UPDATE',[cycle.id]);await allocation.reserveCloser(cycle.id,closerIds);}))); 
    check('real concurrent closer rotation is balanced, durable after reconnect and independent of cycle row locks');
    await db.query('UPDATE sog_contacts SET ghl_contact_id=$2 WHERE id=$1',[contact.id,'test-ghl-contact']);
    const current=Date.now(),appointment={eventId:randomUUID(),appointmentId:'test-appointment-a',contactId:'test-ghl-contact',calendarId:'test-calendar',status:'confirmed',startsAt:new Date(current+86400000).toISOString(),updatedAt:new Date(current).toISOString()};
    await db.saveAppointment(appointment);
    assert.equal((await db.query('SELECT stage FROM sog_sales_cycles WHERE id=$1',[cycle.id])).rows[0].stage,'booked');
    assert.equal((await db.saveAppointment(appointment)).duplicate,true);
    assert.equal((await db.saveAppointment({...appointment,eventId:randomUUID(),status:'cancelled',updatedAt:new Date(current-1000).toISOString()})).stale,true);
    await db.saveAppointment({...appointment,eventId:randomUUID(),appointmentId:'test-appointment-b',updatedAt:new Date(current+1000).toISOString()});
    await db.saveAppointment({...appointment,eventId:randomUUID(),status:'cancelled',updatedAt:new Date(current+2000).toISOString()});
    assert.equal((await db.query('SELECT stage FROM sog_sales_cycles WHERE id=$1',[cycle.id])).rows[0].stage,'booked');
    check('appointment deduplication, stale updates and cancellation guards execute on PostgreSQL');
    await db.query("INSERT INTO sog_booking_intents(id,application_id,cycle_id,start_time,timezone,state) VALUES($1,$2,$3,now(),'UTC','pending')",[randomUUID(),input.submissionId,cycle.id]);
    await assert.rejects(db.query("INSERT INTO sog_booking_intents(id,application_id,cycle_id,start_time,timezone,state) VALUES($1,$2,$3,now(),'UTC','pending')",[randomUUID(),input.submissionId,cycle.id]),{code:'23505'});
    check('database unique constraint prevents two active booking intents for one cycle');
    await db.query("UPDATE sog_sales_cycles SET status='lost',stage='lost' WHERE id=$1",[cycle.id]);
    await db.saveApplication(form(input.contact.email));
    const {rows:[newCycle]}=await db.query("SELECT * FROM sog_sales_cycles WHERE contact_id=$1 AND status='open'",[contact.id]);
    assert.notEqual(newCycle.id,cycle.id);
    await db.query("UPDATE sog_sales_cycles SET stage='follow_up' WHERE id=$1",[newCycle.id]);
    await db.saveAppointment({...appointment,eventId:randomUUID(),appointmentId:'test-appointment-b',status:'cancelled',updatedAt:new Date(current+3000).toISOString()});
    assert.equal((await db.query('SELECT stage FROM sog_sales_cycles WHERE id=$1',[newCycle.id])).rows[0].stage,'follow_up');
    check('late appointment from lost cycle cannot mutate a new sales cycle');
    const signals=require('../../lib/ghl-signal');
    process.env.GHL_CALENDAR_IDS='test-calendar';
    const signal=signals.signal({kind:'appointment',resourceId:'signal-appointment',locationId:'3mi3YQaZvtUMZzaQUuL6',contactId:'test-ghl-contact',workflowKey:'appointment-state-v1'});
    await signals.enqueue(signal);await signals.enqueue(signal);
    const read=async resource=>{assert.equal(resource,'/calendars/events/appointments/signal-appointment');return {event:{id:'signal-appointment',locationId:'3mi3YQaZvtUMZzaQUuL6',calendarId:'test-calendar',contactId:'test-ghl-contact',appointmentStatus:'confirmed',startTime:new Date(current+86400000).toISOString(),dateUpdated:new Date(current+4000).toISOString()}};};
    assert.equal((await signals.processOne({read})).processed,1);
    assert.equal((await signals.processOne({read})).processed,1);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM sog_events WHERE payload->>'appointmentId'='signal-appointment'")).rows[0].n),1);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM sog_provider_signals WHERE status='delivered'")).rows[0].n),2);
    check('provider signal inbox processes duplicate readbacks once without HTTP');
    await db.rateLimit('integration-limit',1);await assert.rejects(db.rateLimit('integration-limit',1),{message:'rate_limited'});
    check('durable rate limiting increments atomically');
    await require('./outbox-failure-fixture.cjs')(db,cycle.id);
    check('outbox SQL failures roll back delivery writes and commit retry counters through terminal exhaustion');
    await require('./dashboard-fixtures.cjs')(db,contact.id,newCycle.id,input.journeyId);
    check('dashboard campaign dimensions and current outcomes share a deduplicated first-booked cohort');
    process.stdout.write(JSON.stringify({ok:true,checks:checks.length,providerWrites:0,scope:'random disposable schema'})+'\n');
  } finally {
    if(migrationConnection){await migrationConnection.query('ROLLBACK').catch(()=>{});migrationConnection.release();}
    if(allocation)await allocation.closeAllocationPool();
    if(db)await db.getPool().end();
    try{if(created)await admin.query('DROP SCHEMA "'+config.schema+'" CASCADE');}finally{await admin.end();global.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];Object.assign(process.env,originalEnv);}
  }
}
if(require.main===module)run().catch(error=>{process.stderr.write('PostgreSQL validation failed: '+(error.code || (error.name==='AssertionError'?'assertion_failed':/^(Set |SOG_TEST_|Invalid test|Test URL|Pass )/.test(error.message)?error.message:'validation_error'))+'\n');process.exitCode=1;});
module.exports={safetyConfiguration,run};
