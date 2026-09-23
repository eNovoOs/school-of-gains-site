const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {touch}=require('../lib/attribution');
const config=require('../vercel.json');
const client=fs.readFileSync(require.resolve('../src/acquisition/attribution.js'),'utf8');
function capture(url,storage=new Map()){
 const window={location:new URL(url),document:{referrer:''},navigator:{},crypto:{randomUUID},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},fetch:async()=>({ok:true}),dispatchEvent(){}};
 vm.runInNewContext(client,{window,URL,URLSearchParams,Date,CustomEvent:class{}});return window.SOGAttribution.get();
}
test('two retired links redirect temporarily to existing shared pages without hardcoded UTMs',()=>{
 const targets={'/linktree-mads':'/links','/special-offer-dc':'/apply'};
 for(const [source,target] of Object.entries(targets)){
  const route=config.redirects.find(r=>r.source===source);assert.equal(route.statusCode,302);
  const destination=new URL(route.destination,'https://school-of-gains.com');assert.equal(destination.pathname,target);assert.equal(destination.searchParams.get('route_map_version'),'v1');
  assert.deepEqual([...destination.searchParams.keys()].sort(),['legacy_route','route_map_version']);assert.equal(fs.existsSync(require('node:path').join(__dirname,'../src/acquisition/pages',target.slice(1)+'.html')),true);
 }
});
test('meetup fallback retains inferred provenance and explicit incoming UTMs/click IDs always win',()=>{
 const marker={legacy_route:'legacy_001',route_map_version:'v1'};
 const result=touch(marker);assert.equal(result.source,'meetup');assert.equal(result.medium,'offline');assert.equal(result.confidence,'legacy_path_inferred');assert.equal(result.utm_source,undefined);
 for(const tracking of [{utm_source:'instagram',utm_medium:'organic_social'},{gclid:'google-click'},{utm_campaign:'partial-campaign'},{fbclid:'meta-click'}]){
  const actual=touch({...marker,...tracking});assert.notEqual(actual.confidence,'legacy_path_inferred');for(const [key,value] of Object.entries(tracking))assert.equal(actual[key],value);
 }
 for(const marker of [{legacy_route:'legacy_033',route_map_version:'v1'},{legacy_route:'legacy_001'},{legacy_route:'legacy_001',route_map_version:'v2'}])assert.equal(touch(marker).source,'direct');
});
test('redirect marker survives browser capture, consented journey latest changes on fresh meetup visit',()=>{
 const storage=new Map([['sog_analytics_consent','granted']]);
 capture('https://school-of-gains.com/links?utm_source=google&utm_medium=cpc',storage);
 const next=capture('https://school-of-gains.com/links?legacy_route=legacy_001&route_map_version=v1',storage);
 assert.equal(touch(next.firstTouch).source,'google');assert.equal(touch(next.latestTouch).source,'meetup');
 const explicit=capture('https://school-of-gains.com/links?legacy_route=legacy_001&route_map_version=v1&utm_source=instagram&utm_medium=organic_social');assert.equal(touch(explicit.latestTouch).source,'instagram');
});
