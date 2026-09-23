const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {lead,saveLead}=require('../lib/lead-intake');
const {reserveLeadCreation,syncLead,leadContactUpdate,selectOpportunity,ENTRY_STAGES,ATTR_FIELDS,SETTERS,CLOSERS}=require('../lib/lead-ghl');
const body=()=>({submissionId:randomUUID(),journeyId:randomUUID(),offer:'community',contact:{email:' Person@Example.com ',firstName:' Person '},consent:{privacy:true,marketing:false},attribution:{utm_source:'instagram',utm_medium:'paid_social'}});
const ids=Object.fromEntries(ATTR_FIELDS.map(key=>[key,'field_'+key]));
const canonical={id:'contact',email:'person@example.com',ghl_contact_id:'ghl',first_touch:{source:'meetup',medium:'offline'},latest_touch:{source:'instagram',medium:'paid_social'}};
test('lead capture validates consent and allowlisted offers; never accepts actor or stage claims',()=>{
 const raw=body();raw.bookingSetterId='spoof';raw.pipelineStageId='spoof';const input=lead(raw);assert.equal(input.contact.email,'person@example.com');assert.equal(input.bookingSetterId,undefined);assert.equal(input.pipelineStageId,undefined);assert.equal(input.attribution.latestTouch.source,'instagram');assert.equal(lead(raw,{offer:'free_lessons'}).offer,'free_lessons');
 for(const patch of [{offer:'qualification_quiz'},{consent:{marketing:true}},{submissionId:'bad'},{website:'spam'},{contact:{email:'invalid'}}])assert.throws(()=>lead({...raw,...patch}));
});
test('offer routes are independent of acquisition channel; every supported lead offer has a stage',()=>{assert.equal(ENTRY_STAGES.community,ENTRY_STAGES.newsletter);assert.notEqual(ENTRY_STAGES.free_lessons,ENTRY_STAGES.free_tools);assert.equal(Object.keys(ENTRY_STAGES).length,5);});
test('lead sync preserves remote first attribution and never resets application/ownership/consent',()=>{
 const update=leadContactUpdate(canonical,{firstName:'Person'},{customFields:[{id:ids.first_source,value:'original'}]},ids);
 assert.equal(leadContactUpdate(canonical,{firstName:'Older'},{firstName:'Newer'},ids).firstName,undefined);assert.equal(update.customFields.find(field=>field.id===ids.first_source),undefined);assert.equal(update.customFields.find(field=>field.id===ids.latest_source).fieldValue,'instagram');assert.deepEqual(Object.keys(update).sort(),['customFields','firstName']);assert.throws(()=>leadContactUpdate(canonical,{}, {},{}),/mapping_missing/);
});
test('existing advanced setter deal is reused, closer open/won prevents setter creation, closed setter requires review',()=>{
 const active={id:'existing',pipelineId:SETTERS,pipelineStageId:'connected',status:'open',assignedTo:'owner'};
 assert.equal(selectOpportunity([active]).opportunity,active);
 assert.equal(selectOpportunity([active,{pipelineId:CLOSERS,status:'open'}]).preserveCloser,true);
 assert.equal(selectOpportunity([{pipelineId:CLOSERS,status:'won'}]).preserveCloser,true);
 assert.equal(selectOpportunity([{pipelineId:SETTERS,status:'lost'}]).review,true);
 assert.throws(()=>selectOpportunity([active,{...active,id:'second'}]),/multiple_active/);
});
function harness({opportunities=[],qualified=false,cycle={},failCreate=false,specificOffer}={}) {
 const calls=[],queries=[];
 const c={query:async(sql,params)=>{queries.push({sql,params});if(sql.startsWith('SELECT offer FROM sog_lead_captures'))return {rows:specificOffer?[{offer:specificOffer}]:[]};if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[canonical]};if(sql.startsWith('SELECT * FROM sog_lead_cycles'))return {rows:[{id:'cycle',entry_offer:'free_tools',status:'open',...cycle}]};if(sql.startsWith('SELECT * FROM sog_lead_captures'))return {rows:[{profile:{firstName:'Latest'},id:'newer-capture'}]};if(sql.startsWith('SELECT 1 FROM sog_sales_cycles'))return {rows:[],rowCount:qualified?1:0};return {rows:[],rowCount:1};}};
 const request=async(path,method='GET',data)=>{calls.push({path,method,data});if(path.startsWith('/contacts/'))return {contact:{id:'ghl',email:canonical.email,locationId:'3mi3YQaZvtUMZzaQUuL6'}};if(path.startsWith('/opportunities/search'))return {opportunities};if(method==='PUT' && path.startsWith('/opportunities/'))return {};if(method==='POST'){if(failCreate)throw new Error('ghl_http_503');return {opportunity:{id:'created',pipelineStageId:data.pipelineStageId}};}throw new Error('Unexpected request');};
 let reserved=false;const reserveCreation=async()=>{if(reserved)return false;reserved=true;return true;};
 return {c,request,calls,queries,reserveCreation};
}
const input={contactId:'contact',leadCycleId:'cycle',submissionId:'older-capture'};
test('lead delivery syncs attribution before deal creation; creates in offer stage and retries recover remote deal',async()=>{
 const old=process.env.GHL_ATTRIBUTION_FIELDS_JSON;process.env.GHL_ATTRIBUTION_FIELDS_JSON=JSON.stringify(ids);
 try{
  const h=harness();assert.equal((await syncLead(h.c,input,h)).opportunityId,'created');const creation=h.calls.find(call=>call.path==='/opportunities/');assert.equal(creation.data.pipelineId,SETTERS);assert.equal(creation.data.pipelineStageId,ENTRY_STAGES.free_tools);assert.equal(creation.data.assignedTo,undefined);assert.ok(h.calls.findIndex(call=>call.method==='PUT')<h.calls.indexOf(creation));
  const retry=harness({opportunities:[{id:'created',pipelineId:SETTERS,pipelineStageId:'connected',status:'open',assignedTo:'owner'}]});assert.equal((await syncLead(retry.c,input,retry)).opportunityId,'created');assert.equal(retry.calls.some(call=>call.path==='/opportunities/'),false);assert.equal(retry.calls.some(call=>call.method==='PUT' && call.path.startsWith('/opportunities')),false);
  const failed=harness({failCreate:true});await assert.rejects(syncLead(failed.c,input,failed),/ghl_http_503/);
 }finally{if(old===undefined)delete process.env.GHL_ATTRIBUTION_FIELDS_JSON;else process.env.GHL_ATTRIBUTION_FIELDS_JSON=old;}
});
test('queued qualification and remote closer each prevent a new setter deal; missing remote link requires review',async()=>{
 const old=process.env.GHL_ATTRIBUTION_FIELDS_JSON;process.env.GHL_ATTRIBUTION_FIELDS_JSON=JSON.stringify(ids);
 try{for(const setup of [{qualified:true},{opportunities:[{pipelineId:CLOSERS,status:'open'}]},{cycle:{ghl_opportunity_id:'missing'}}]){const h=harness(setup),result=await syncLead(h.c,input,h);assert.ok(result.preserveCloser || result.review);assert.equal(h.calls.some(call=>call.path==='/opportunities/'),false);}}
 finally{if(old===undefined)delete process.env.GHL_ATTRIBUTION_FIELDS_JSON;else process.env.GHL_ATTRIBUTION_FIELDS_JSON=old;}
});
test('idempotent capture replays queue nothing and reject email or offer mismatch',async()=>{
 const input=lead(body()),queries=[];let duplicate={id:input.submissionId,email:input.contact.email,offer:input.offer};
 const db={transaction:fn=>fn({query:async(sql)=>{queries.push(sql);return {rows:sql.startsWith('SELECT l.id')?[duplicate]:[],rowCount:0};}})};
 assert.deepEqual(await saveLead(input,{db}),{leadId:input.submissionId,duplicate:true});assert.equal(queries.some(sql=>sql.startsWith('INSERT')),false);
 duplicate={...duplicate,offer:'free_tools'};await assert.rejects(saveLead(input,{db}),/idempotency_conflict/);
 duplicate={...duplicate,offer:input.offer,email:'another@example.com'};await assert.rejects(saveLead(input,{db}),/idempotency_conflict/);
});
test('new lead capture commits a canonical attribution snapshot and outbox together, without updating first touch',async()=>{
 const input=lead(body()),queries=[];
 const db={transaction:fn=>fn({query:async(sql,params)=>{queries.push({sql,params});if(sql.startsWith('SELECT * FROM sog_journeys'))return {rows:[{first_touch:input.attribution.firstTouch,latest_touch:input.attribution.latestTouch}]};if(sql.startsWith('SELECT * FROM sog_contacts'))return {rows:[canonical]};if(sql.startsWith('SELECT * FROM sog_lead_cycles'))return {rows:[{id:'cycle'}]};return {rows:[],rowCount:0};}})};
 assert.equal((await saveLead(input,{db})).duplicate,false);
 const capture=queries.find(q=>q.sql.startsWith('INSERT INTO sog_lead_captures'));assert.deepEqual(capture.params[7].firstTouch,canonical.first_touch);assert.equal(capture.params[5].email,canonical.email);
 const outbox=queries.find(q=>q.sql.startsWith('INSERT INTO sog_outbox'));assert.equal(outbox.params[1],'lead');assert.equal(outbox.params[2].leadCycleId,'cycle');assert.equal(queries.some(q=>/^UPDATE .*first_touch/.test(q.sql)),false);
});

test('incomplete or ambiguous remote search and failed field sync cannot create a deal',async()=>{
 const old=process.env.GHL_ATTRIBUTION_FIELDS_JSON;process.env.GHL_ATTRIBUTION_FIELDS_JSON=JSON.stringify(ids);
 try{for(const mode of ['pagination','ambiguous','field_failure']){const h=harness(),original=h.request;h.request=async(path,method,data)=>{if(path.startsWith('/opportunities/search')){h.calls.push({path,method});return mode==='pagination'?{opportunities:[],meta:{nextPage:2}}:{opportunities:[1,2].map(id=>({id,pipelineId:SETTERS,status:'open'}))};}if(method==='PUT' && mode==='field_failure')throw new Error('ghl_http_503');return original(path,method,data);};await assert.rejects(syncLead(h.c,input,h),/ghl_/);assert.equal(h.calls.some(call=>call.path==='/opportunities/'),false);}}
 finally{if(old===undefined)delete process.env.GHL_ATTRIBUTION_FIELDS_JSON;else process.env.GHL_ATTRIBUTION_FIELDS_JSON=old;}
});

test('uncertain creation never repeats POST after empty search, but later matching remote deal recovers',async()=>{
 const old=process.env.GHL_ATTRIBUTION_FIELDS_JSON;process.env.GHL_ATTRIBUTION_FIELDS_JSON=JSON.stringify(ids);
 try{
  const h=harness({failCreate:true});
  await assert.rejects(syncLead(h.c,input,h),/ghl_http_503/);
  await assert.rejects(syncLead(h.c,input,h),/ghl_lead_creation_uncertain_review_required/);
  assert.equal(h.calls.filter(call=>call.path==='/opportunities/').length,1);
  const recovered=harness({opportunities:[{id:'eventually-visible',pipelineId:SETTERS,pipelineStageId:ENTRY_STAGES.free_tools,status:'open'}]});
  recovered.reserveCreation=h.reserveCreation;
  assert.equal((await syncLead(recovered.c,input,recovered)).opportunityId,'eventually-visible');
  assert.equal(recovered.calls.some(call=>call.path==='/opportunities/'),false);
 }finally{if(old===undefined)delete process.env.GHL_ATTRIBUTION_FIELDS_JSON;else process.env.GHL_ATTRIBUTION_FIELDS_JSON=old;}
});
test('durable creation reservation uses unique cycle and commits independently before delivery',async()=>{
 const rows=new Set(),queries=[];
 const transaction=async fn=>fn({query:async(sql,params)=>{queries.push(sql);const exists=rows.has(params[0]);rows.add(params[0]);return {rowCount:exists?0:1};}});
 const id=randomUUID();assert.equal(await reserveLeadCreation(id,'remote-contact',transaction),true);assert.equal(await reserveLeadCreation(id,'remote-contact',transaction),false);
 assert.ok(queries.every(sql=>sql.includes('ON CONFLICT(cycle_id) DO NOTHING')));
});

test('generic Contact Created deal refines to earliest specific capture only while new and unassigned',async()=>{
 const old=process.env.GHL_ATTRIBUTION_FIELDS_JSON;process.env.GHL_ATTRIBUTION_FIELDS_JSON=JSON.stringify(ids);
 try{
  const generic={id:'existing',pipelineId:SETTERS,pipelineStageId:ENTRY_STAGES.community,status:'open'};
  const h=harness({cycle:{entry_offer:'community'},specificOffer:'free_lessons',opportunities:[generic]});
  await syncLead(h.c,input,h);
  assert.deepEqual(h.calls.find(call=>call.path==='/opportunities/existing').data,{pipelineStageId:ENTRY_STAGES.free_lessons});
  assert.equal(h.queries.find(q=>q.sql.startsWith('UPDATE sog_lead_cycles SET entry_offer')).params[1],'free_lessons');
  assert.ok(h.queries.some(q=>q.sql.includes('ORDER BY created_at ASC,id ASC')));
  const fresh=harness({cycle:{entry_offer:'newsletter'},specificOffer:'free_tools'});await syncLead(fresh.c,input,fresh);assert.equal(fresh.calls.find(call=>call.path==='/opportunities/').data.pipelineStageId,ENTRY_STAGES.free_tools);
  for(const patch of [{assignedTo:'owner'},{pipelineStageId:'connected'},{pipelineStageId:ENTRY_STAGES.webinar},{status:'lost'}]){
   const preserved=harness({cycle:{entry_offer:'community'},specificOffer:'free_lessons',opportunities:[{...generic,...patch}]});await syncLead(preserved.c,input,preserved);assert.equal(preserved.calls.some(call=>call.path.startsWith('/opportunities/') && call.method==='PUT'),false);assert.equal(preserved.queries.some(q=>q.sql.startsWith('UPDATE sog_lead_cycles SET entry_offer')),false);
  }
  const alreadySpecific=harness({cycle:{entry_offer:'free_tools'},specificOffer:'free_lessons',opportunities:[generic]});await syncLead(alreadySpecific.c,input,alreadySpecific);assert.equal(alreadySpecific.calls.some(call=>call.path.startsWith('/opportunities/') && call.method==='PUT'),false);
 }finally{if(old===undefined)delete process.env.GHL_ATTRIBUTION_FIELDS_JSON;else process.env.GHL_ATTRIBUTION_FIELDS_JSON=old;}
});
