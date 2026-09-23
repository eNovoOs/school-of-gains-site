const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const allocator=require('../lib/attribution-assignment');
const {syncApplication,FIELD_KEYS}=require('../lib/attribution-ghl');
const ids=['BCR448vrYnQHOwub4MEd','Rt4YE2nRGqKHwKkq2jVo'];
function store(){
  const assignments=new Map();let position=0n,tail=Promise.resolve(),locks=0;
  async function transaction(fn){let unlock,locked=false;const c={query:async(sql,p)=>{
    if(sql.startsWith('SELECT pg_advisory_xact_lock')){const before=tail;tail=new Promise(resolve=>unlock=resolve);await before;locked=true;locks++;return {rows:[]};}
    assert.equal(locked,true,'all allocation queries must hold shared pool lock');
    if(sql.startsWith('SELECT closer_id'))return {rows:assignments.has(p[0])?[{closer_id:assignments.get(p[0]).closer}]:[]};
    if(sql.startsWith('INSERT INTO sog_closer_rotation'))return {rows:[]};
    if(sql.startsWith('UPDATE sog_closer_rotation'))return {rows:[{position:String(position++)}]};
    if(sql.startsWith('INSERT INTO sog_closer_assignments')){assert.equal(assignments.has(p[0]),false);assignments.set(p[0],{closer:p[1],poolVersion:p[3],poolMembers:p[4]});return {rows:[]};}
    throw new Error('unexpected query '+sql);
  }};try{return await fn(c);}finally{if(unlock)unlock();}}
  return {transaction,assignments,get position(){return position;},get locks(){return locks;}};
}
test('closer pool rejects absent, malformed and duplicate IDs; no single-user fallback',()=>{assert.throws(()=>allocator.closerIds(undefined));assert.throws(()=>allocator.closerIds(''));assert.throws(()=>allocator.closerIds(ids[0]+','+ids[0]));assert.deepEqual(allocator.closerIds(ids.join(',')),ids);});
test('concurrent new cycles alternate evenly under one shared allocation lock',async()=>{const s=store();const cycles=Array.from({length:9},()=>randomUUID());const selected=await Promise.all(cycles.map(cycle=>allocator.reserveCloser(cycle,ids,s.transaction)));assert.deepEqual(selected,cycles.map((_,i)=>ids[i%2]));assert.equal(s.assignments.size,9);assert.equal(s.position,9n);assert.equal(s.locks,9);});
test('concurrent retries reuse one durable reservation without consuming turns',async()=>{const s=store(),cycle=randomUUID();const selected=await Promise.all(Array.from({length:12},()=>allocator.reserveCloser(cycle,ids,s.transaction)));assert.deepEqual([...new Set(selected)],[ids[0]]);assert.equal(s.position,1n);assert.equal(s.assignments.size,1);assert.equal(await allocator.reserveCloser(randomUUID(),ids,s.transaction),ids[1]);});
test('pool configuration changes do not reassign an already reserved cycle',async()=>{const s=store(),cycle=randomUUID();await allocator.reserveCloser(cycle,ids,s.transaction);assert.equal(await allocator.reserveCloser(cycle,[...ids].reverse(),s.transaction),ids[0]);assert.deepEqual(s.assignments.get(cycle).poolMembers,ids);});
test('existing open opportunity retains owner and consumes no rotation turn',async()=>{
  const oldFetch=global.fetch,oldReserve=allocator.reserveCloser,oldEnv={...process.env};Object.assign(process.env,{GHL_SYNC_ENABLED:'true',GHL_PRIVATE_INTEGRATION_TOKEN:'test',GHL_UNBOOKED_STAGE_ID:'stage'});delete process.env.GHL_CLOSER_IDS;
  let reserved=false;allocator.reserveCloser=async()=>{reserved=true;throw new Error('must_not_allocate')};global.fetch=async()=>({ok:true,json:async()=>({opportunities:[{id:'existing',status:'open',assignedTo:'retained-owner'}]})});const writes=[];
  const c={query:async(sql,p)=>{writes.push({sql,p});if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[{id:'local',ghl_contact_id:'ghl'}]};if(sql.startsWith('SELECT * FROM sog_sales_cycles'))return {rows:[{id:randomUUID()}]};if(sql.startsWith('SELECT id,created_at'))return {rows:[{id:'later-submission'}]};return {rows:[]};}};
  try{await syncApplication(c,{contactId:'local',cycleId:randomUUID(),submissionId:'old'});assert.equal(reserved,false);const ownerWrite=writes.find(x=>x.sql.includes('assigned_closer_id'));assert.equal(ownerWrite.p[2],'retained-owner');}finally{global.fetch=oldFetch;allocator.reserveCloser=oldReserve;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);}
});
test('provider create follows owner reservation and timeout retry never blindly creates again',async()=>{
  const oldFetch=global.fetch,oldReserve=allocator.reserveCloser,oldEnv={...process.env};Object.assign(process.env,{GHL_SYNC_ENABLED:'true',GHL_PRIVATE_INTEGRATION_TOKEN:'test',GHL_UNBOOKED_STAGE_ID:'stage'});
  const s=store(),cycle=randomUUID(),owners=[];let committed=false;
  process.env.GHL_ATTRIBUTION_FIELDS_JSON=JSON.stringify(Object.fromEntries(FIELD_KEYS.map(k=>[k,k])));
  allocator.reserveCloser=async id=>{const result=await allocatorOriginal(id,ids,s.transaction);committed=true;return result};const allocatorOriginal=oldReserve;
  global.fetch=async(url,options)=>{if(options.method==='POST'){assert.equal(committed,true);owners.push(JSON.parse(options.body).assignedTo);throw new Error('provider timeout');}return {ok:true,json:async()=>url.includes('/contacts/')?{contact:{id:'ghl',email:'person@example.com'}}:{opportunities:[]}};};
  const c={query:async sql=>{if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[{id:'local',ghl_contact_id:'ghl'}]};if(sql.startsWith('SELECT * FROM sog_sales_cycles'))return {rows:[{id:cycle}]};if(sql.startsWith('SELECT id,created_at'))return {rows:[{id:'submission',cycle_id:cycle,created_at:new Date(),answers:{},consent:{}}]};if(sql.startsWith('SELECT email,first_touch'))return {rows:[{email:'person@example.com',first_touch:{},latest_touch:{}}]};return {rows:[]};}};
  let attempted=false;const deps={reserveCreation:async()=>{if(attempted)return false;attempted=true;return true;}};
  try{for(let i=0;i<2;i++){committed=false;await assert.rejects(syncApplication(c,{contactId:'local',cycleId:cycle,submissionId:'submission'},deps),{message:i===0?'provider timeout':'ghl_opportunity_creation_uncertain_review_required'});}assert.deepEqual(owners,[ids[0]]);assert.equal(s.position,1n);}finally{global.fetch=oldFetch;allocator.reserveCloser=oldReserve;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);}
});
