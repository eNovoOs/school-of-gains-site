const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {reconcileSetterHandoff}=require('../../lib/ghl-signal');
const LOCATION='3mi3YQaZvtUMZzaQUuL6',SETTERS='PSq0fv77HbtMg9bdKC2p',HANDOFF='2f75b70e-62fd-4b31-a72f-381f2a505165';

// SQL integration only, in the harness-owned disposable schema. The injected
// provider read returns fixture identity; global fetch remains prohibited.
module.exports=async function setterHandoffFixture(db){
 assert.match((await db.query('SELECT current_schema() AS name')).rows[0].name,/^sog_test_[0-9a-f]{32}$/);
 const contactId=randomUUID(),otherContact=randomUUID(),cycleId=randomUUID(),otherCycle=randomUUID(),closedCycle=randomUUID();
 const providerId='fixture-contact-'+randomUUID(),email='setter-handoff-'+randomUUID()+'@example.invalid';
 const signalId=randomUUID(),claimToken=randomUUID(),opportunityId='fixture-deal-'+randomUUID();
 await db.query("INSERT INTO sog_contacts(id,email,ghl_contact_id,first_touch,latest_touch) VALUES($1,$2,$3,'{}','{}'),($4,$5,$6,'{}','{}')",[contactId,email,providerId,otherContact,'other-'+email,'fixture-other-'+randomUUID()]);
 await db.query("INSERT INTO sog_sales_cycles(id,contact_id,status,stage) VALUES($1,$2,'open','booked'),($3,$4,'open','booked'),($5,$2,'lost','lost')",[cycleId,contactId,otherCycle,otherContact,closedCycle]);
 const active='fixture-active-'+randomUUID(),cancelled='fixture-cancelled-'+randomUUID(),otherActive='fixture-other-active-'+randomUUID(),closedActive='fixture-closed-active-'+randomUUID();
 for(const [id,contact,cycle,status]of [[active,contactId,cycleId,'confirmed'],[cancelled,contactId,cycleId,'cancelled'],[otherActive,otherContact,otherCycle,'confirmed'],[closedActive,contactId,closedCycle,'confirmed']]){
  await db.query("INSERT INTO sog_appointments(id,contact_id,cycle_id,calendar_id,status,starts_at,updated_at,attribution) VALUES($1,$2,$3,'fixture-calendar',$4,now()+interval '1 day',now(),'{}')",[id,contact,cycle,status]);
 }
 const blocked='ghl_manual_setter_transfer_pending';
 const fixtures=[
  {key:'exhausted',status:'failed',attempts:10,error:blocked,appointment:active,cycle:cycleId},
  {key:'pending',status:'pending',attempts:8,error:blocked,appointment:active,cycle:cycleId},
  {key:'different_error',status:'failed',attempts:10,error:'ghl_http_403',appointment:active,cycle:cycleId},
  {key:'generic_exhausted',status:'failed',attempts:10,error:'ghl_retry_exhausted',appointment:active,cycle:cycleId},
  {key:'delivered',status:'delivered',attempts:2,error:blocked,appointment:active,cycle:cycleId},
  {key:'cancelled',status:'failed',attempts:10,error:blocked,appointment:cancelled,cycle:cycleId},
  {key:'other_contact',status:'failed',attempts:10,error:blocked,appointment:otherActive,cycle:otherCycle},
  {key:'closed_cycle',status:'failed',attempts:10,error:blocked,appointment:closedActive,cycle:closedCycle},
  {key:'application',type:'application',status:'failed',attempts:10,error:blocked,appointment:active,cycle:cycleId},
  {key:'wrong_cycle',status:'failed',attempts:10,error:blocked,appointment:active,cycle:otherCycle}
 ];
 for(const f of fixtures){
  const event=randomUUID();
  await db.query("INSERT INTO sog_events(event_id,type,contact_id,payload) VALUES($1,'fixture_handoff',$2,'{}')",[event,contactId]);
  const {rows:[row]}=await db.query("INSERT INTO sog_outbox(event_id,type,payload,status,attempts,last_error,available_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day') RETURNING *",[event,f.type||'appointment',{cycleId:f.cycle,appointmentId:f.appointment},f.status,f.attempts,f.error]);
  f.before=row;
 }
 await db.query("INSERT INTO sog_provider_signals(id,kind,resource_id,contact_id,workflow_key,claim_token,lease_until) VALUES($1,'opportunity',$2,$3,'opportunity-state-v1',$4,now()-interval '1 second')",[signalId,opportunityId,providerId,claimToken]);
 const payload={pipelineId:SETTERS,pipelineStageId:HANDOFF,status:'open',contactId:providerId,opportunityId};
 const job={id:signalId,claimToken};
 const read=async path=>{assert.equal(path,'/contacts/'+providerId);return {contact:{id:providerId,locationId:LOCATION,email}};};
 const run=(input=payload)=>reconcileSetterHandoff(input,job,db,read,{ATTRIBUTION_PILOT_EMAILS:email});
 await assert.rejects(run(),/signal_lease_lost/);
 for(const f of fixtures)assert.deepEqual((await db.query('SELECT * FROM sog_outbox WHERE id=$1',[f.before.id])).rows[0],f.before,'Expired receipt must not reset '+f.key);
 await db.query("UPDATE sog_provider_signals SET lease_until=now()+interval '5 minutes' WHERE id=$1",[signalId]);
 const results=await Promise.all([run(),run()]);
 assert.deepEqual(results.map(r=>r.requeued).sort((a,b)=>a-b),[0,2],'Concurrent duplicate handoff resets two eligible jobs exactly once');
 for(const f of fixtures){
  const {rows:[after]}=await db.query('SELECT * FROM sog_outbox WHERE id=$1',[f.before.id]);
  if(['exhausted','pending'].includes(f.key)){
   assert.equal(after.status,'pending');assert.equal(after.attempts,0);assert.equal(after.last_error,null);
   assert.ok(new Date(after.available_at)<new Date(f.before.available_at));
   assert.deepEqual(after.payload,f.before.payload);assert.equal(after.event_id,f.before.event_id);
  }else assert.deepEqual(after,f.before,'Unrelated job must remain byte-for-byte unchanged: '+f.key);
 }
 assert.equal((await run()).requeued,0,'Replay after wakeup must not reset attempt counters again');
 await db.query("UPDATE sog_appointments SET status='cancelled' WHERE id=$1",[active]);
 await assert.rejects(run(),/setter_booking_not_linked_retry/);
 assert.deepEqual(await run({...payload,pipelineStageId:'other-stage'}),{ignored:true});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_sales_cycles WHERE contact_id=$1',[contactId])).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_appointments WHERE contact_id=$1',[contactId])).rows[0].n,3);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_sales_tasks WHERE cycle_id=$1',[cycleId])).rows[0].n,0);
 return ['setter handoff wakes only exact pending/exhausted manual-transfer jobs for real active bookings; duplicate and expired receipt fences preserve other jobs'];
};
