const db=require('./attribution-db');
const provider=require('./attribution-ghl');
async function processOne(deps={}) {
 const storage=deps.db || db,application=deps.syncApplication || provider.syncApplication,appointment=deps.syncAppointment || provider.syncAppointment;
 return storage.transaction(async c=>{
  const {rows:[job]}=await c.query("SELECT * FROM sog_outbox WHERE status='pending' AND available_at<=now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
  if(!job)return {processed:0};
  if(job.attempts>=10){await c.query("UPDATE sog_outbox SET status='failed',last_error='ghl_retry_exhausted' WHERE id=$1",[job.id]);return {processed:0,needsReview:true};}
  // Keep the claim lock outside the savepoint so SQL failures can be recorded.
  await c.query('SAVEPOINT outbox_delivery');
  try {
   if(job.type==='application')await application(c,job.payload);
   else if(job.type==='appointment')await appointment(c,job.payload);
   else throw new Error('ghl_unsupported_job');
   await c.query("UPDATE sog_outbox SET status='delivered',attempts=attempts+1,last_error=NULL WHERE id=$1",[job.id]);
   await c.query('RELEASE SAVEPOINT outbox_delivery');
   return {processed:1};
  }catch(error){
   await c.query('ROLLBACK TO SAVEPOINT outbox_delivery');
   await c.query('RELEASE SAVEPOINT outbox_delivery');
   const code=/^ghl_[a-z0-9_]+$/.test(error.message)?error.message:'ghl_delivery_failed';
   await c.query("UPDATE sog_outbox SET attempts=attempts+1,status=CASE WHEN attempts>=9 THEN 'failed' ELSE 'pending' END,last_error=$2,available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,10)))::int) WHERE id=$1",[job.id,code]);
   return {processed:0,retryQueued:job.attempts<9,needsReview:job.attempts>=9};
  }
 });
}
module.exports={processOne};
