const {createHash}=require('node:crypto');
const {InputError}=require('./attribution');
const POOL_KEY='3mi3YQaZvtUMZzaQUuL6:apprentice:closers';
let allocationPool;
function closerIds(value=process.env.GHL_CLOSER_IDS) {
  if(typeof value!=='string')throw new InputError('ghl_closer_pool_not_configured',503);
  const ids=value.split(',').map(x=>x.trim());
  if(!ids.length || ids.some(id=>!/^\w{10,100}$/.test(id)) || new Set(ids).size!==ids.length)throw new InputError('ghl_closer_pool_invalid',503);
  return ids;
}
async function allocationTransaction(fn) {
  if(!process.env.DATABASE_URL)throw new InputError('storage_unavailable',503);
  // Separate from the outbox pool: its transaction already owns a connection
  // while this durable reservation must commit before the remote API call.
  // The reservation tables intentionally do not lock/reference sales-cycle rows.
  if(!allocationPool){const {Pool}=require('pg');allocationPool=new Pool({connectionString:process.env.DATABASE_URL,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:5000});}
  const c=await allocationPool.connect();
  try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function reserveCloser(cycleId,ids=closerIds(),transaction=allocationTransaction) {
  if(!/^[0-9a-f-]{36}$/i.test(cycleId || ''))throw new InputError('invalid_sales_cycle');
  ids=closerIds(ids.join(','));
  const poolVersion=createHash('sha256').update(ids.join(',')).digest('hex');
  return transaction(async c=>{
    // One lock orders every new allocation across workers and pool revisions.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[POOL_KEY]);
    const {rows:[existing]}=await c.query('SELECT closer_id FROM sog_closer_assignments WHERE cycle_id=$1',[cycleId]);
    if(existing)return existing.closer_id;
    await c.query('INSERT INTO sog_closer_rotation(pool_key,next_position) VALUES($1,0) ON CONFLICT DO NOTHING',[POOL_KEY]);
    const {rows:[counter]}=await c.query('UPDATE sog_closer_rotation SET next_position=next_position+1 WHERE pool_key=$1 RETURNING next_position-1 AS position',[POOL_KEY]);
    const selected=ids[Number(BigInt(counter.position)%BigInt(ids.length))];
    await c.query('INSERT INTO sog_closer_assignments(cycle_id,closer_id,pool_key,pool_version,pool_members) VALUES($1,$2,$3,$4,$5)',[cycleId,selected,POOL_KEY,poolVersion,ids]);
    return selected;
  });
}
module.exports={closerIds,reserveCloser};
