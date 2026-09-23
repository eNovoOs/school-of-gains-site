const {InputError}=require('./attribution');
let pool;
async function transaction(fn){
 if(!process.env.DATABASE_URL)throw new InputError('storage_unavailable',503);
 if(!pool){const {Pool}=require('pg');pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:5000});}
 const c=await pool.connect();
 try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function reserve(cycleId,contactId,run=transaction){
 if(!/^[0-9a-f-]{36}$/i.test(cycleId || '') || !/^[a-zA-Z0-9_-]{1,100}$/.test(contactId || ''))throw new Error('ghl_opportunity_creation_identity_invalid');
 return run(async c=>{
  const result=await c.query('INSERT INTO sog_opportunity_creation_attempts(cycle_id,ghl_contact_id) VALUES($1,$2) ON CONFLICT(cycle_id) DO NOTHING RETURNING cycle_id',[cycleId,contactId]);
  if(result.rowCount)return true;
  const {rows:[prior]}=await c.query('SELECT ghl_contact_id FROM sog_opportunity_creation_attempts WHERE cycle_id=$1',[cycleId]);
  if(prior?.ghl_contact_id!==contactId)throw new Error('ghl_opportunity_creation_identity_invalid');
  return false;
 });
}
async function close(){if(pool){const prior=pool;pool=undefined;await prior.end();}}
module.exports={reserve,close};
