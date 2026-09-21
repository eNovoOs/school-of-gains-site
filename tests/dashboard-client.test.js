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
