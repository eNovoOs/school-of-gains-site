const {test}=require('node:test');const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {attest,parseAttestation,setterRoster}=require('../lib/setter-credit');
const env={SETTER_CREDIT_ENABLED:'true',SETTER_CREDIT_SETTERS_JSON:JSON.stringify([{id:'setter1',name:'Fixture Setter'}]),ATTRIBUTION_PILOT_EMAILS:'media@revupcmo.com'};
const input=()=>({appointmentId:'appt1',setterId:'setter1',requestId:randomUUID(),reason:'Reviewed original booking activity.'});
const hash='a'.repeat(64),contact={id:'contact1',locationId:'3mi3YQaZvtUMZzaQUuL6',email:'media@revupcmo.com'};
function setup(t,{existing,credit,booking=true}={}){
 const old=process.env.GHL_CALENDAR_IDS;process.env.GHL_CALENDAR_IDS='calendar1';t.after(()=>old===undefined?delete process.env.GHL_CALENDAR_IDS:process.env.GHL_CALENDAR_IDS=old);
 const writes=[];const query=async(sql,args)=>{
  if(sql.startsWith('SELECT a.id,c.email'))return {rows:[{id:'appt1',email:contact.email,ghl_contact_id:contact.id}]};
  if(sql.startsWith('SELECT a.*'))return {rows:booking?[{id:'appt1',ghl_contact_id:'contact1',booking_setter_id:existing}]:[]};
  if(sql.startsWith('SELECT * FROM sog_booking_setter_credits'))return {rows:sql.includes('appointment_id')&&credit?[credit]:[]};
  writes.push({sql,args});return {rowCount:1,rows:[]};
 };
 const db={query,transaction:fn=>fn({query})};
 const read=async path=>path.startsWith('/contacts/')?{contact}:{event:{id:'appt1',contactId:'contact1',locationId:contact.locationId,calendarId:'calendar1',appointmentStatus:'confirmed',startTime:'2027-01-01T12:00:00Z',dateUpdated:'2026-01-01T12:00:00Z'}};
 return {db,read,writes,env};
}
test('roster validation refuses unknown setters and accepts only configured identity',()=>{
 assert.throws(()=>setterRoster({}),/setter_roster_invalid/);
 assert.throws(()=>parseAttestation({...input(),setterId:'caller-invented'},env),/setter_not_allowed/);
 assert.throws(()=>parseAttestation({...input(),reason:'short'},env),/credit_reason_required/);
});
test('attestation stores explicit evidence and changes only exact appointment credit',async t=>{
 const deps=setup(t);const data=input();const result=await attest(data,hash,deps);
 assert.equal(result.evidenceType,'admin_attested');
 const inserted=deps.writes.find(w=>w.sql.startsWith('INSERT'));
 assert.match(inserted.sql,/'admin_attested'/);assert.equal(inserted.args[4],hash);
 assert.deepEqual(deps.writes.filter(w=>w.sql.startsWith('UPDATE')).map(w=>w.args),[['appt1','setter1']]);
 assert.equal(deps.writes.some(w=>w.sql.includes('UPDATE sog_sales_cycles')),false);
});
test('conflicting existing setter credit is never overwritten',async t=>{
 const deps=setup(t,{existing:'other-setter'});
 await assert.rejects(attest(input(),hash,deps),/credit_already_recorded/);
 assert.equal(deps.writes.some(w=>/^(INSERT|UPDATE)/.test(w.sql)),false);
});
test('same credit is idempotent and preserves original attestation',async t=>{
 const deps=setup(t,{existing:'setter1',credit:{setter_id:'setter1',evidence_type:'admin_attested'}});
 assert.equal((await attest(input(),hash,deps)).duplicate,true);
 assert.equal(deps.writes.some(w=>/^(INSERT|UPDATE)/.test(w.sql)),false);
});
test('unverified booking and foreign provider contact cannot receive credit',async t=>{
 const deps=setup(t,{booking:false});await assert.rejects(attest(input(),hash,deps),/verified_booking_required/);
 const second=setup(t);const original=second.read;second.read=async path=>path.startsWith('/contacts/')?{contact:{...contact,email:'different@example.invalid'}}:original(path);
 await assert.rejects(attest(input(),hash,second),/credit_contact_mismatch/);
});
test('disabled flag, missing session evidence and nonpilot contacts fail closed',async t=>{
 const deps=setup(t);
 await assert.rejects(attest(input(),hash,{...deps,env:{...env,SETTER_CREDIT_ENABLED:'false'}}),/setter_credit_disabled/);
 await assert.rejects(attest(input(),'browser-label',deps),/admin_evidence_missing/);
 await assert.rejects(attest(input(),hash,{...deps,env:{...env,ATTRIBUTION_PILOT_EMAILS:'other@example.invalid'}}),/intake_unavailable/);
});
test('credit endpoint requires dashboard authentication before any credit processing',async t=>{
 const auth=require('../lib/dashboard-auth');const configured=auth.configured,authenticated=auth.authenticated;
 auth.configured=()=>true;auth.authenticated=()=>false;t.after(()=>{auth.configured=configured;auth.authenticated=authenticated;});
 let status;const res={setHeader(){},status(code){status=code;return this;},json(data){return data;}};
 const response=await require('../api/dashboard/setter-credit')({method:'POST',headers:{},body:input()},res);
 assert.equal(status,401);assert.equal(response.error,'unauthorized');
});
test('authenticated POST still rejects cross-origin requests before storage',async t=>{
 const auth=require('../lib/dashboard-auth');const configured=auth.configured,authenticated=auth.authenticated,sameOrigin=auth.sameOrigin,flag=process.env.SETTER_CREDIT_ENABLED;
 auth.configured=()=>true;auth.authenticated=()=>true;auth.sameOrigin=()=>false;process.env.SETTER_CREDIT_ENABLED='true';
 t.after(()=>{auth.configured=configured;auth.authenticated=authenticated;auth.sameOrigin=sameOrigin;flag===undefined?delete process.env.SETTER_CREDIT_ENABLED:process.env.SETTER_CREDIT_ENABLED=flag;});
 let status;const res={setHeader(){},status(code){status=code;return this;},json(data){return data;}};
 const response=await require('../api/dashboard/setter-credit')({method:'POST',headers:{},body:input()},res);
 assert.equal(status,403);assert.equal(response.error,'origin_not_allowed');
});
