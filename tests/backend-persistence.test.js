const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const db=require('../lib/attribution-db');
const {syncApplication,syncAppointment}=require('../lib/attribution-ghl');
function fakeConnection(query){return {query,release(){}};}
test('duplicate submission returns original ID without creating events, cycles or outbox',async()=>{
  const previous=process.env.DATABASE_URL; process.env.DATABASE_URL='postgres://localhost/not_connected';
  const pool=db.getPool(); const original=pool.connect; const id=randomUUID(); const statements=[];
  pool.connect=async()=>fakeConnection(async(sql)=>{statements.push(sql);return sql.startsWith('SELECT a.id')?{rowCount:1,rows:[{id,email:'person@example.com'}]}:{rowCount:0,rows:[]};});
  try {const result=await db.saveApplication({submissionId:id,contact:{email:'person@example.com'}});assert.equal(result.duplicate,true);assert.equal(result.applicationId,id);assert.equal(statements.filter(s=>s.startsWith('INSERT')).length,0);}
  finally {pool.connect=original;if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;}
});
test('reusing a submission ID for another identity fails and rolls back',async()=>{
  process.env.DATABASE_URL='postgres://localhost/not_connected';const pool=db.getPool();const original=pool.connect;const statements=[];
  pool.connect=async()=>fakeConnection(async sql=>{statements.push(sql);return sql.startsWith('SELECT a.id')?{rowCount:1,rows:[{email:'other@example.com'}]}:{rows:[]};});
  try{await assert.rejects(db.saveApplication({submissionId:randomUUID(),contact:{email:'person@example.com'}}),{message:'idempotency_conflict'});assert.ok(statements.includes('ROLLBACK'));}finally{pool.connect=original;delete process.env.DATABASE_URL;}
});
test('older appointment update is retained as evidence but never changes current appointment or cycle',async()=>{
  process.env.DATABASE_URL='postgres://localhost/not_connected';const pool=db.getPool();const original=pool.connect;const statements=[];
  pool.connect=async()=>fakeConnection(async sql=>{statements.push(sql);if(sql.startsWith('SELECT 1 FROM sog_events'))return {rowCount:0,rows:[]};if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[{id:randomUUID()}]};if(sql.startsWith('SELECT * FROM sog_appointments'))return {rows:[{updated_at:'2026-09-21T12:00:00Z'}]};return {rows:[]};});
  try{assert.deepEqual(await db.saveAppointment({appointmentId:'a',contactId:'c',eventId:randomUUID(),status:'cancelled',updatedAt:'2026-09-21T11:00:00Z'}),{stale:true});assert.equal(statements.filter(s=>s.startsWith('UPDATE')).length,0);assert.ok(statements.some(s=>s.startsWith('INSERT INTO sog_events')));}finally{pool.connect=original;delete process.env.DATABASE_URL;}
});
test('GHL retries adopt existing opportunity without resetting owner or claiming booking',async()=>{
  const oldFetch=global.fetch;const oldEnv={...process.env};Object.assign(process.env,{GHL_SYNC_ENABLED:'true',GHL_PRIVATE_INTEGRATION_TOKEN:'test',GHL_UNBOOKED_STAGE_ID:'unbooked-test',GHL_ATTRIBUTION_FIELDS_JSON:JSON.stringify(Object.fromEntries(['application_id','cycle_id','quiz_version','answers','first_source','first_medium','first_campaign','latest_source','latest_medium','latest_campaign'].map(k=>[k,k])))});
  const requests=[];global.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({opportunities:[{id:'existing',status:'open',assignedTo:'original-owner',pipelineStageId:'follow-up'}],meta:{}})}};
  const statements=[];const connection=fakeConnection(async(sql,params)=>{statements.push({sql,params});if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[{id:'local',ghl_contact_id:'ghl'}]};if(sql.startsWith('SELECT * FROM sog_sales_cycles'))return {rows:[{id:'cycle'}]};return {rows:[]};});
  try{const result=await syncApplication(connection,{contactId:'local',cycleId:'cycle',contact:{email:'p@example.com'},answers:{},attribution:{firstTouch:{},latestTouch:{}}});assert.equal(result.opportunityId,'existing');assert.equal(requests.length,2);assert.equal(requests[0].options.method,'GET');assert.ok(requests[0].url.includes('status=all'));assert.equal(statements.filter(s=>s.sql.includes('SET stage')).length,0);}finally{global.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);}
});
test('appointment sync protects a won opportunity from stage regression',async()=>{
  const oldFetch=global.fetch;const oldEnv={...process.env};Object.assign(process.env,{GHL_SYNC_ENABLED:'true',GHL_PRIVATE_INTEGRATION_TOKEN:'test',GHL_STAGE_IDS_JSON:JSON.stringify({unbooked:'stage'})});
  const requests=[];global.fetch=async(url,options)=>{requests.push(options.method);return {ok:true,json:async()=>({opportunity:{id:'opp',pipelineId:'GxJOcIsgv7Svx90E2BZr',status:'won'}})}};
  try{await syncAppointment(fakeConnection(async()=>({rows:[{id:'cycle',ghl_opportunity_id:'opp',status:'open',stage:'unbooked'}]})),{cycleId:'cycle'});assert.deepEqual(requests,['GET']);}finally{global.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);}
});
test('cancelling one appointment cannot unbook another active appointment',async()=>{
  process.env.DATABASE_URL='postgres://localhost/not_connected';const pool=db.getPool();const original=pool.connect;const statements=[];
  pool.connect=async()=>fakeConnection(async(sql,params)=>{statements.push({sql,params});if(sql.startsWith('SELECT 1 FROM sog_events'))return {rowCount:0,rows:[]};if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[{id:randomUUID(),first_touch:{},latest_touch:{}}]};if(sql.startsWith('SELECT * FROM sog_appointments'))return {rows:[]};if(sql.startsWith('SELECT * FROM sog_sales_cycles'))return {rows:[{id:randomUUID(),status:'open',stage:'booked'}]};if(sql.startsWith('SELECT 1 FROM sog_appointments'))return {rowCount:1,rows:[{}]};return {rows:[]};});
  try{await db.saveAppointment({appointmentId:'a',contactId:'c',eventId:randomUUID(),status:'cancelled',updatedAt:'2026-09-21T12:00:00Z'});const guard=statements.find(x=>x.sql.startsWith('SELECT 1 FROM sog_appointments'));assert.equal(guard.params[3],true);assert.equal(statements.filter(x=>x.sql.startsWith('UPDATE sog_sales_cycles')).length,0);}finally{pool.connect=original;delete process.env.DATABASE_URL;}
});
test('late retry cannot overwrite fields from the latest application',async()=>{
  const oldFetch=global.fetch;const oldEnv={...process.env};Object.assign(process.env,{GHL_UNBOOKED_STAGE_ID:'unbooked-test'});global.fetch=async()=>{throw new Error('unexpected_remote_write')};
  const connection=fakeConnection(async sql=>{if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[{id:'local',ghl_contact_id:'ghl'}]};if(sql.startsWith('SELECT * FROM sog_sales_cycles'))return {rows:[{id:'cycle',ghl_opportunity_id:'existing'}]};if(sql.startsWith('SELECT id FROM sog_applications'))return {rows:[{id:'new-submission'}]};return {rows:[]};});
  try{assert.equal((await syncApplication(connection,{contactId:'local',cycleId:'cycle',submissionId:'old-submission'})).opportunityId,'existing');}finally{global.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);}
});
