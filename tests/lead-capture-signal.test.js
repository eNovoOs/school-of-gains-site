const test=require('node:test'),assert=require('node:assert/strict');
const {signal,normalize,enqueue,processOne,remoteAttribution}=require('../lib/lead-capture-signal');
const LOCATION='3mi3YQaZvtUMZzaQUuL6';
const env={GHL_LEAD_CAPTURE_ROUTES_JSON:JSON.stringify({'community-v1':'community','lessons-v1':'free_lessons'}),ATTRIBUTION_PILOT_EMAILS:'media@revupcmo.com',GHL_ATTRIBUTION_FIELDS_JSON:JSON.stringify({first_touch_snapshot:'first',latest_touch_snapshot:'latest'})};
const raw={locationId:LOCATION,contactId:'contact-1',captureKey:'community-v1'};
const contact={id:'contact-1',locationId:LOCATION,email:'media@revupcmo.com',firstName:'Test',customFields:[{id:'first',value:JSON.stringify({source:'meetup',medium:'offline',captured_at:'2020-01-01T00:00:00Z'})},{id:'latest',value:JSON.stringify({utm_source:'youtube',utm_medium:'organic_social',gclid:'click-evidence',captured_at:'2020-01-02T00:00:00Z'})}]};
test('lead webhook projects minimal trusted route; rejects conflicting standard payload fields',()=>{
 assert.deepEqual(signal({...raw,email:'ignored',consent:true},env),{contactId:'contact-1',captureKey:'community-v1',offer:'community'});
 assert.deepEqual(signal({customData:raw,contact_id:'contact-1',location:{id:LOCATION},email:'ignored'},env),signal(raw,env));
 for(const bad of [{...raw,captureKey:'unknown'},{customData:raw,contact_id:'different'},{customData:raw,contactId:'different'},{customData:raw,location:{id:'wrong'}}])assert.throws(()=>signal(bad,env));
 assert.throws(()=>signal(raw,{GHL_LEAD_CAPTURE_ROUTES_JSON:'{}'}),/routes_invalid/);
});
test('provider readback verifies identity/pilot; stable lead ID, unknown consent, preserved old first touch',async()=>{
 const payload=await normalize(signal(raw,env),async()=>({contact}),env);
 assert.equal(payload.ghlContactId,contact.id);assert.deepEqual(payload.consent,{privacy:null,marketing:false,basis:'existing_ghl_contact'});assert.equal(payload.attribution.firstTouch.source,'meetup');assert.equal(payload.attribution.firstTouch.captured_at,'2020-01-01T00:00:00.000Z');assert.equal(payload.attribution.latestTouch.source,'youtube');assert.equal(payload.attribution.latestTouch.gclid,'click-evidence');
 assert.equal((await normalize(signal(raw,env),async()=>({contact}),env)).submissionId,payload.submissionId);
 assert.notEqual((await normalize(signal({...raw,captureKey:'lessons-v1'},env),async()=>({contact}),env)).submissionId,payload.submissionId);
 for(const patch of [{id:'wrong'},{locationId:'wrong'},{email:'another@example.com'},{email:''}])await assert.rejects(normalize(signal(raw,env),async()=>({contact:{...contact,...patch}}),env));
});
test('missing provider attribution remains unknown rather than fabricated direct traffic',async()=>{
 const value=await normalize(signal(raw,env),async()=>({contact:{...contact,customFields:[]}}),env);assert.equal(value.attribution.firstTouch.source,'unknown');assert.equal(value.attribution.latestTouch.medium,'unknown');
});
test('inbox persists only resource and configured route evidence, no raw webhook PII',async()=>{
 let params;const result=await enqueue(signal({...raw,email:'secret@example.com'},env),{query:async(sql,values)=>{params=values;}});assert.equal(result.accepted,true);assert.deepEqual(params.slice(1),['contact-1','community-v1','community']);assert.equal(JSON.stringify(params).includes('secret'),false);
});
test('worker commits lease before provider readback and saves lead before acknowledging',async()=>{
 const calls=[];const storage={transaction:async fn=>{const result=await fn({query:async(sql)=>{calls.push(sql);return {rows:sql.startsWith('SELECT')?[{id:'receipt',ghl_contact_id:'contact-1',capture_key:'community-v1',offer:'community',attempts:0}]:[]};}});calls.push('lease-committed');return result;},query:async sql=>{calls.push(sql);return {rowCount:1};}};
 const result=await processOne({db:storage,env,read:async()=>{calls.push('read-provider');return {contact};},saveLead:async payload=>{calls.push('save-lead');assert.equal(payload.consent.privacy,null);}});
 assert.equal(result.processed,1);assert.ok(calls.indexOf('lease-committed')<calls.indexOf('read-provider'));assert.ok(calls.indexOf('save-lead')<calls.findIndex(x=>x.includes("status='delivered'")));
});
test('identity mismatch never saves a lead and becomes visible failed inbox item',async()=>{
 let saved=false,last;const storage={transaction:fn=>fn({query:async sql=>({rows:sql.startsWith('SELECT')?[{id:'receipt',ghl_contact_id:'contact-1',capture_key:'community-v1',offer:'community',attempts:0}]:[]})}),query:async(sql,params)=>{last=params;return {rowCount:1};}};
 const result=await processOne({db:storage,env,read:async()=>({contact:{...contact,locationId:'wrong'}}),saveLead:async()=>{saved=true;}});assert.equal(saved,false);assert.equal(result.needsReview,true);assert.equal(last[2],true);
});

test('native first/latest attribution retains UTMs separately and does not confuse session channel with source',()=>{
 const result=remoteAttribution({attributionSource:{utmSource:'google',utmMedium:'cpc',campaign:'first-campaign',utmContent:'ad-a',utmKeyword:'learn',url:'https://school-of-gains.com/links?gclid=first-click&email=private',sessionSource:'Paid Search',clickId:'ambiguous-click',campaignId:'native-campaign-id'},lastAttributionSource:{utmSource:'youtube',utmMedium:'organic_social',utmCampaign:'latest-campaign',utmContent:'video'}},env);
 assert.equal(result.firstTouch.source,'google');assert.equal(result.firstTouch.utm_campaign,'first-campaign');assert.equal(result.firstTouch.utm_term,'learn');assert.equal(result.firstTouch.gclid,'first-click');assert.equal(result.firstTouch.ghl_clickId,'ambiguous-click');assert.equal(result.firstTouch.ghl_campaignId,'native-campaign-id');assert.equal(result.firstTouch.utm_id,undefined);assert.equal(result.firstTouch.landing_page,'https://school-of-gains.com/links');assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(result.firstTouch.ghl_sessionSource,'Paid Search');assert.equal(result.latestTouch.source,'youtube');assert.equal(result.latestTouch.utm_campaign,'latest-campaign');assert.equal(result.latestTouch.gclid,undefined);assert.equal(result.latestTouch.timestamp_basis,'provider_readback');
});
test('SOG snapshots take precedence over native attribution without mixed campaign data',()=>{
 const result=remoteAttribution({...contact,attributionSource:{utmSource:'facebook',utmMedium:'paid_social',campaign:'native-conflict'},lastAttributionSource:{utmSource:'google',utmMedium:'cpc'}},env);
 assert.equal(result.firstTouch.source,'meetup');assert.equal(result.firstTouch.utm_campaign,undefined);assert.equal(result.latestTouch.source,'youtube');assert.equal(result.firstTouch.attribution_origin,'sog_snapshot');
});
test('native URL UTMs can fill missing fields; generic contact source and channel alone never fabricate platform',()=>{
 const result=remoteAttribution({source:'Facebook form',attributionSource:{sessionSource:'Paid Social',clickId:'untyped'},lastAttributionSource:{url:'https://school-of-gains.com/?utm_source=instagram&utm_medium=organic_social&utm_campaign=profile',utmSource:'youtube'}},env);
 assert.equal(result.firstTouch.source,'unknown');assert.equal(result.firstTouch.medium,'unknown');assert.equal(result.firstTouch.gclid,undefined);assert.equal(result.firstTouch.fbclid,undefined);assert.equal(result.latestTouch.source,'youtube');assert.equal(result.latestTouch.medium,'organic_social');assert.equal(result.latestTouch.utm_campaign,'profile');
 const absent=remoteAttribution({source:'Direct'},env);assert.equal(absent.firstTouch.source,'unknown');assert.equal(absent.latestTouch.source,'unknown');
});
test('malformed or empty SOG snapshots fall back to native; mapped existing SOG fields keep precedence',()=>{
 assert.equal(remoteAttribution({customFields:[{id:'first',value:'bad json'}],attributionSource:{utmSource:'meetup',utmMedium:'offline'}},env).firstTouch.source,'meetup');
 const mapped={...env,GHL_ATTRIBUTION_FIELDS_JSON:JSON.stringify({first_source:'existing-source',first_campaign:'existing-campaign'})};
 const result=remoteAttribution({customFields:[{id:'existing-source',value:'discord'},{id:'existing-campaign',value:'community'}],attributionSource:{utmSource:'google',utmMedium:'cpc'}},mapped);
 assert.equal(result.firstTouch.source,'discord');assert.equal(result.firstTouch.medium,'unknown');assert.equal(result.firstTouch.utm_campaign,'community');
});
