const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname,'../src/dashboard/dashboard.js'),'utf8');
class Element {
  constructor(tag='div') { this.tag=tag;this.children=[];this.textContent='';this.listeners={};this.value='30'; }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children=elements;this.textContent=''; }
  addEventListener(name,fn) { this.listeners[name]=fn; }
}
const flush = async()=>{for(let i=0;i<20;i++) await Promise.resolve();};
const baseline=()=>({summary:{visits:1,applications:2,bookings:1,attributedApplications:1},channels:[],health:{},generatedAt:new Date().toISOString(),window:{start:'2026-09-01',end:'2026-09-21'},campaigns:[],outcomes:{active:0,cancelled:0,attended:0,missed:0,other:0}});
async function dashboard(data) {
  const elements = new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let response=data;
  vm.runInNewContext(script,{document:{getElementById:get,createElement:tag=>new Element(tag)},fetch:async url=>({ok:response!==null,json:async()=>url.includes('stats')?response:{}}),Date,Number,Error});
  await flush();
  return {get,setData(value){response=value;},async refresh(){get('filters').listeners.submit({preventDefault(){}});await flush();},async logout(){await get('logout').listeners.click();await flush();}};
}
test('campaign and outcomes render aggregate counts safely with distinct blank attribution labels',async()=>{
  const b=await dashboard({...baseline(),campaigns:[{source:'<img src=x onerror=alert(1)>',medium:'event',campaign:'',content:null,applications:3,bookings:2}],outcomes:{active:1,cancelled:2,attended:3,missed:4,other:5}});
  const cells=b.get('campaigns').children[0].children;
  assert.deepEqual(cells.map(c=>c.textContent),['<img src=x onerror=alert(1)>','event','(not set)','(not set)','3','2']);
  assert.ok(cells.every(c=>c.tag==='td' && c.children.length===0));
  assert.deepEqual(b.get('outcomes').children.map(r=>r.children.map(c=>c.textContent)),[['Active','1'],['Cancelled','2'],['Attended','3'],['Missed','4'],['Other','5']]);
});
test('empty results differ from unavailable outcomes and optional API sections',async()=>{
  const b=await dashboard(baseline());
  assert.match(b.get('campaigns').children[0].children[0].textContent,/No applications/);
  assert.equal(b.get('campaigns').children[0].children[0].colSpan,6);
  assert.equal(b.get('outcomes').children[0].children[1].textContent,'0');
  b.setData({...baseline(),campaigns:undefined,outcomes:undefined});await b.refresh();
  assert.match(b.get('campaigns').children[0].children[0].textContent,/unavailable/);
  assert.equal(b.get('outcomes').children[0].textContent,'Booking outcomes unavailable.');
});
test('refresh failures and logout clear previously rendered campaign and outcome counts',async()=>{
  const b=await dashboard(baseline());b.setData(null);await b.refresh();
  assert.equal(b.get('campaigns').children.length,0);assert.equal(b.get('outcomes').children.length,0);
  assert.match(b.get('status').textContent,/Reporting unavailable/);
  b.setData(baseline());await b.refresh();assert.equal(b.get('outcomes').children.length,5);
  await b.logout();assert.equal(b.get('outcomes').children.length,0);assert.equal(b.get('campaigns').children.length,0);assert.equal(b.get('report').hidden,true);
});

test('booking recovery health remains separate from confirmed bookings and missing counts are unavailable',async()=>{
 const b=await dashboard({...baseline(),health:{pendingBookingRecoveries:4,reviewBookingRecoveries:2}});
 const recoveryRows=()=>b.get('health').children.slice(0,2).map(r=>r.children.map(c=>c.textContent));
 assert.deepEqual(recoveryRows(),[['Booking requests being checked','4'],['Booking requests needing review','2']]);
 assert.equal(b.get('metrics').children[2].children[1].textContent,'1');
 b.setData({...baseline(),health:{pendingBookingRecoveries:0}});await b.refresh();
 assert.deepEqual(recoveryRows(),[['Booking requests being checked','0'],['Booking requests needing review','Unavailable']]);
 b.setData({...baseline(),health:{pendingBookingRecoveries:-1,reviewBookingRecoveries:'2'}});await b.refresh();
 assert.deepEqual(recoveryRows().map(r=>r[1]),['Unavailable','Unavailable']);
 b.setData(null);await b.refresh();assert.equal(b.get('health').children.length,0);
 b.setData({...baseline(),health:{pendingBookingRecoveries:4,reviewBookingRecoveries:2}});await b.refresh();
 await b.logout();assert.equal(b.get('health').children.length,0);
});

test('lead captures remain separate from applications and task queues render in health',async()=>{
 const b=await dashboard({...baseline(),routing:{leads:{enabled:true,distinctContacts:3,captures:5,pendingDeliveries:2,failedDeliveries:1},tasks:{enabled:true,pending:4,review:2}}});
 assert.deepEqual(b.get('leads').children.map(r=>r.children.map(c=>c.textContent)),[['Distinct lead contacts','3'],['Lead capture submissions','5']]);
 assert.equal(b.get('metrics').children[1].children[1].textContent,'2');
 assert.deepEqual(b.get('health').children.filter(r=>['Pending lead CRM deliveries','Failed lead CRM deliveries','Managed tasks awaiting sync','Managed tasks needing review'].includes(r.children[0].textContent)).map(r=>r.children.map(c=>c.textContent)),[['Pending lead CRM deliveries','2'],['Failed lead CRM deliveries','1'],['Managed tasks awaiting sync','4'],['Managed tasks needing review','2']]);
 await b.logout();assert.equal(b.get('leads').children.length,0);
});
test('disabled or missing lead/task counts are never rendered as zero',async()=>{
 const b=await dashboard({...baseline(),routing:{leads:{enabled:false},tasks:{enabled:false}}});
 assert.equal(b.get('leads').children[0].textContent,'Lead intake reporting is not enabled.');
 assert.equal(b.get('health').children.at(-1).children[1].textContent,'Not enabled');
 b.setData({...baseline(),routing:{leads:{enabled:true,captures:0},tasks:{enabled:true,pending:-1,review:'2'}}});await b.refresh();
 assert.equal(b.get('leads').children[0].children[1].textContent,'Unavailable');
 assert.equal(b.get('leads').children[1].children[1].textContent,'0');
 assert.deepEqual(b.get('health').children.slice(-2).map(r=>r.children[1].textContent),['Unavailable','Unavailable']);
 b.setData(null);await b.refresh();assert.equal(b.get('leads').children.length,0);
});

test('native lead signal queue is separate and disabled/missing signal reporting has no zero counts',async()=>{
 const b=await dashboard({...baseline(),routing:{leadSignals:{enabled:true,pending:3,failed:1}}});
 const signalRows=()=>b.get('health').children.filter(r=>r.children[0]?.textContent.includes('GHL lead'));
 assert.deepEqual(signalRows().map(r=>r.children.map(c=>c.textContent)),[['Pending GHL lead signals','3'],['Failed GHL lead signals','1']]);
 b.setData({...baseline(),routing:{leadSignals:{enabled:false}}});await b.refresh();
 assert.deepEqual(signalRows()[0].children.map(c=>c.textContent),['GHL lead signal reporting','Not enabled']);
 b.setData(baseline());await b.refresh();assert.equal(signalRows()[0].children[1].textContent,'Unavailable');
});

test('lead routing reviews remain visible despite successful delivery and distinguish zero/disabled/unavailable',async()=>{
 const report=reviewCycles=>({...baseline(),routing:{leads:{enabled:true,distinctContacts:1,captures:1,pendingDeliveries:0,failedDeliveries:0,reviewCycles}}});
 const b=await dashboard(report(2));
 const health=label=>b.get('health').children.find(r=>r.children[0]?.textContent===label)?.children[1].textContent;
 assert.equal(health('Failed lead CRM deliveries'),'0');assert.equal(health('Pending lead CRM deliveries'),'0');assert.equal(health('Lead deals needing routing review'),'2');
 b.setData(report(0));await b.refresh();assert.equal(health('Lead deals needing routing review'),'0');
 for(const value of [undefined,null,-1,'2']){b.setData(report(value));await b.refresh();assert.equal(health('Lead deals needing routing review'),'Unavailable');}
 b.setData({...baseline(),routing:{leads:{enabled:false}}});await b.refresh();assert.equal(health('Lead routing review reporting'),'Not enabled');assert.equal(health('Lead deals needing routing review'),undefined);
 b.setData(baseline());await b.refresh();assert.equal(health('Lead routing review reporting'),'Unavailable');
 b.setData(report(2));await b.refresh();await b.logout();assert.equal(b.get('health').children.length,0);
});

test('cohort funnel renders person counts and rates while setter evidence stays explicit',async()=>{
 const f={summary:{leads:4,qualified:3,booked:2,won:1,totalWon:2,wonWithoutVerifiedBooking:1},coverage:{leadCaptureIncluded:true,leadCaptureEntry:2,quizEntry:1,directBookingEntry:1,qualifiedWithoutQuiz:1,unknownSource:0},channels:[{source:'meetup',medium:'offline',leads:4,qualified:3,booked:2,won:1,total_won:2}],campaigns:[]};
 const b=await dashboard({...baseline(),funnel:f,setters:{bookings:2,unknownBookings:1,evidenceLedgerEnabled:true,rows:[{setter_id:'staff1',setter_name:'<script>bad</script>',evidence:'admin_attested',bookings:1,contacts:1,won_contacts:0},{setter_id:null,evidence:'unknown',bookings:1,contacts:1,won_contacts:1}]}});
 assert.deepEqual(b.get('funnel-summary').children.map(x=>x.children[1].textContent),['4','3','2','1']);
 assert.deepEqual(b.get('funnel-channels').children[0].children.map(x=>x.textContent),['meetup','offline','4','3','2','1','2','50.0%','25.0%']);
 assert.match(b.get('funnel-coverage').textContent,/All won people: 2/);
 assert.deepEqual(b.get('setter-credit').children.map(x=>x.children.slice(0,2).map(v=>v.textContent)),[['<script>bad</script>','Administrator attestation'],['Unknown','No credit recorded']]);
 assert.equal(b.get('setter-credit').children[0].children[0].children.length,0);
 await b.logout();for(const id of ['funnel-summary','funnel-channels','setter-credit'])assert.equal(b.get(id).children.length,0);
});
test('missing cohorts and setter reports are unavailable, partial acquisition coverage explicit',async()=>{
 const b=await dashboard(baseline());assert.match(b.get('funnel-summary').children[0].textContent,/unavailable/);assert.match(b.get('setter-credit').children[0].children[0].textContent,/unavailable/);
 b.setData({...baseline(),funnel:{summary:{leads:0,qualified:0,booked:0,won:0,totalWon:0,wonWithoutVerifiedBooking:0},coverage:{leadCaptureIncluded:false},channels:[],campaigns:[]}});await b.refresh();assert.match(b.get('funnel-coverage').textContent,/coverage is partial/);
 b.setData(null);await b.refresh();assert.equal(b.get('funnel-summary').children.length,0);assert.equal(b.get('funnel-coverage').textContent,'');
});

test('a report finishing after sign-out cannot restore private metrics',async()=>{
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 let finishStats;
 vm.runInNewContext(script,{document:{getElementById:get,createElement:tag=>new Element(tag)},fetch:async url=>url.includes('stats')?await new Promise(resolve=>{finishStats=()=>resolve({ok:true,json:async()=>baseline()});}):({ok:true,json:async()=>({})}),Date,Number,Error});
 await flush();assert.equal(get('report').hidden,false);
 await get('logout').listeners.click();await flush();assert.equal(get('report').hidden,true);
 finishStats();await flush();
 for(const id of ['metrics','channels','campaigns','funnel-summary','setter-credit'])assert.equal(get(id).children.length,0);
});
