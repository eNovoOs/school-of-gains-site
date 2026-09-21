const assert=require('node:assert/strict');
const {processOne}=require('../../lib/attribution-outbox');
module.exports=async function validateOutboxFailure(db,cycleId){
 // Only the random-schema validation harness calls this fixture.
 await db.query("UPDATE sog_outbox SET status='delivered'");
 const {rows:[job]}=await db.query('SELECT id FROM sog_outbox ORDER BY id LIMIT 1');
 await db.query("UPDATE sog_outbox SET status='pending',attempts=0,available_at=now() WHERE id=$1",[job.id]);
 const original=(await db.query('SELECT stage FROM sog_sales_cycles WHERE id=$1',[cycleId])).rows[0].stage;
 const failing=async c=>{
  await c.query("UPDATE sog_sales_cycles SET stage='must_rollback' WHERE id=$1",[cycleId]);
  await c.query('SELECT 1/0'); // Genuine PostgreSQL error aborts the transaction.
 };
 for(let attempt=1;attempt<=10;attempt++){
  const result=await processOne({db,syncApplication:failing,syncAppointment:failing});
  const row=(await db.query('SELECT status,attempts,last_error FROM sog_outbox WHERE id=$1',[job.id])).rows[0];
  assert.equal(row.attempts,attempt);assert.equal(row.status,attempt===10?'failed':'pending');
  assert.equal(row.last_error,'ghl_delivery_failed');assert.equal(result.needsReview,attempt===10);
  assert.equal((await db.query('SELECT stage FROM sog_sales_cycles WHERE id=$1',[cycleId])).rows[0].stage,original);
  if(attempt<10)await db.query('UPDATE sog_outbox SET available_at=now() WHERE id=$1',[job.id]);
 }
};
