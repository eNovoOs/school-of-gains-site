const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require('node:path').join(__dirname, '../src/acquisition/book.js'), 'utf8');
async function run(ref, response) {
  const elements = {};
  const document = { querySelector(id) { return elements[id] ||= { textContent: '', hidden: true, addEventListener() {} }; } };
  const calls = [];
  vm.runInNewContext(script, { document, location: { search: '?ref=' + ref }, URLSearchParams, fetch: async (url, config) => { calls.push({ url, config }); return { ok: response.ok, status: response.status, json: async () => response.body }; } });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls };
}
test('missing reference does not request a booking or claim application success', async () => {
  const r = await run('', {});
  assert.equal(r.calls.length, 0);
  assert.equal(r.elements['#booking-restart'].hidden, false);
  assert.match(r.elements['#booking-heading'].textContent, /Start/);
});
test('verified application explicitly remains unbooked with disabled integration', async () => {
  const r = await run('opaque_signed_reference_123456789', { ok: true, status: 200, body: { ok: true, bookingEnabled: false } });
  assert.match(r.elements['#booking-heading'].textContent, /received/);
  assert.match(r.elements['#booking-detail'].textContent, /No appointment has been booked/);
  assert.equal(r.calls[0].config.cache, 'no-store');
  assert.equal(r.calls.length, 1);
});
test('expired context never presents a saved application or a booking', async () => {
  const r = await run('opaque_signed_reference_123456789', { ok: false, status: 401, body: {} });
  assert.match(r.elements['#booking-heading'].textContent, /no longer available/);
  assert.equal(r.elements['#booking-refresh'].hidden, false);
});
async function interactive(responses) {
  const elements = {};
  const calls = [];
  const slotTime = new Date(Date.now() + 86400000).toISOString();
  const slot = { dataset: { slot: slotTime }, setAttribute() {} };
  const document = { querySelector(id) { return elements[id] ||= { textContent: '', innerHTML: '', hidden: true, handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, querySelectorAll() { return [slot]; } }; } };
  const fetch = async (url, config) => {
    calls.push({ url, config });
    const response = url.startsWith('/api/booking-context') ? { ok: true, status: 200, body: { ok: true, bookingEnabled: true, existingBooking: responses.contexts?.length ? responses.contexts.shift() : responses.existing || null } } : url.startsWith('/api/booking-slots') ? { ok: true, status: 200, body: { ok: true, slots: [slotTime] } } : responses.posts.shift();
    return { ok: response.ok, status: response.status, json: async () => response.body };
  };
  vm.runInNewContext(script, { document, location: { search: '?ref=opaque_signed_reference_123456789' }, URLSearchParams, crypto: require('node:crypto'), fetch });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls, slotTime, async choose() { await elements['#booking-slots'].handlers.click({ target: { closest() { return slot; } } }); }, async confirm() { await elements['#confirm-booking'].handlers.click(); } };
}
test('stale slot refreshes availability and permits another selection without success', async () => {
  const r = await interactive({ posts: [{ ok: false, status: 409, body: { ok: false, error: 'slot_unavailable' } }] });
  await r.choose(); await r.confirm();
  assert.match(r.elements['#booking-error'].textContent, /no longer available/);
  assert.equal(r.elements['#booking-timezone'].disabled, false);
  assert.notEqual(r.elements['#booking-heading'].textContent, 'Your call is booked.');
  assert.equal(r.calls.filter(c => c.url.startsWith('/api/booking-slots')).length, 2);
});
test('pending booking locks selection and retries identical request before verified success', async () => {
  const time = new Date(Date.now() + 86400000).toISOString();
  const r = await interactive({ posts: [{ ok: true, status: 202, body: { ok: true, booked: false, pending: true } }, { ok: true, status: 200, body: { ok: true, booked: true, appointmentId: 'verified-appointment', startTime: time } }] });
  await r.choose(); await r.confirm();
  assert.equal(r.elements['#booking-timezone'].disabled, true);
  assert.equal(r.elements['#confirm-booking'].textContent, 'Check confirmation');
  assert.notEqual(r.elements['#booking-heading'].textContent, 'Your call is booked.');
  await r.confirm();
  const posts = r.calls.filter(c => c.url === '/api/bookings');
  assert.equal(posts[0].config.body, posts[1].config.body);
  assert.equal(r.elements['#booking-heading'].textContent, 'Your call is booked.');
  assert.equal(r.elements['#booking-picker'].hidden, true);
});
test('reload restores previous pending booking ID instead of creating a new request', async () => {
  const id = require('node:crypto').randomUUID();
  const time = new Date(Date.now() + 86400000).toISOString();
  const r = await interactive({ existing: { bookingId: id, startTime: time, timezone: 'UTC', state: 'pending', canRetry: true }, posts: [{ ok: true, status: 202, body: { ok: true, pending: true } }] });
  await r.confirm();
  const request = JSON.parse(r.calls.find(c => c.url === '/api/bookings').config.body);
  assert.equal(request.bookingId, id);
  assert.equal(request.startTime, time);
  assert.equal(r.calls.some(c => c.url.startsWith('/api/booking-slots')), false);
});
test('existing appointment conflict blocks new slot choices', async () => {
  const r = await interactive({ posts: [{ ok: false, status: 409, body: { ok: false, error: 'appointment_already_exists' } }] });
  await r.choose(); await r.confirm();
  assert.equal(r.elements['#confirm-booking'].hidden, true);
  assert.equal(r.elements['#booking-timezone'].disabled, true);
  assert.match(r.elements['#booking-error'].textContent, /sales team/);
});

test('cancelled and invalid appointments allow a fresh booking without restoring cancelled identity or claiming confirmation', async () => {
 for (const state of ['cancelled', 'invalid']) {
  const oldId = require('node:crypto').randomUUID();
  const r = await interactive({ existing: { bookingId: oldId, startTime: new Date(Date.now()+86400000).toISOString(), timezone: 'UTC', state, canRetry: false }, posts: [{ ok: true, status: 202, body: { ok: true, pending: true } }] });
  assert.equal(r.elements['#booking-picker'].hidden, false);
  assert.match(r.elements['#booking-heading'].textContent, /no longer booked/);
  assert.ok(r.calls.some(c => c.url.startsWith('/api/booking-slots')));
  assert.equal(r.calls.some(c => c.url === '/api/bookings'), false);
  await r.choose(); await r.confirm();
  const request = JSON.parse(r.calls.find(c => c.url === '/api/bookings').config.body);
  assert.notEqual(request.bookingId, oldId);
  assert.equal(request.startTime, r.slotTime);
  assert.notEqual(r.elements['#booking-heading'].textContent, 'Your call is booked.');
 }
});

async function syncing(contexts) {
  const elements={},handlers={},timers=new Map(),calls=[];let timerId=0;
  const document={hidden:false,addEventListener(name,fn){handlers[name]=fn;},querySelector(id){return elements[id] ||= {textContent:'',innerHTML:'',hidden:true,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},querySelectorAll(){return [];}};}};
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  vm.runInNewContext(script,{document,location:{search:'?ref=opaque_signed_reference_123456789'},URLSearchParams,setTimeout(fn,delay){timers.set(++timerId,{fn,delay});return timerId;},clearTimeout(id){timers.delete(id);},fetch:async url=>{calls.push(url);const body=url.startsWith('/api/booking-slots')?{ok:true,slots:[]}:(contexts.length>1?contexts.shift():contexts[0]);return {ok:true,status:200,json:async()=>body};}});
  await flush();
  return {elements,calls,timers,async tick(){const [id,t]=timers.entries().next().value;timers.delete(id);t.fn();await flush();},async visibility(hidden){document.hidden=hidden;handlers.visibilitychange();await flush();},async refresh(){await elements['#booking-refresh'].handlers.click();await flush();}};
}
const pendingSync={ok:true,bookingEnabled:false,crmPending:true,reason:'contact_sync_pending'};
test('actual pending CRM sync automatically advances to slots without another submission or booking',async()=>{
 const r=await syncing([pendingSync,{ok:true,bookingEnabled:true}]);
 assert.match(r.elements['#booking-detail-heading'].textContent,/Preparing/);assert.equal(r.timers.size,1);
 await r.tick();assert.equal(r.elements['#booking-picker'].hidden,false);assert.equal(r.timers.size,0);
 assert.equal(r.calls.filter(x=>x.startsWith('/api/booking-context')).length,2);
 assert.ok(r.calls.every(x=>x.startsWith('/api/booking-context')||x.startsWith('/api/booking-slots')));
});
test('sync polling backs off, stops after bounded attempts and supports explicit refresh',async()=>{
 const r=await syncing([pendingSync]);const delays=[];
 while(r.timers.size){delays.push(r.timers.values().next().value.delay);await r.tick();}
 assert.deepEqual(delays,[2000,4000,8000,16000,30000,30000]);assert.equal(r.calls.length,7);
 assert.match(r.elements['#booking-detail'].textContent,/taking longer/);assert.equal(r.elements['#booking-refresh'].disabled,false);
 await r.refresh();assert.equal(r.timers.size,1);assert.equal(r.calls.length,8);
});
test('hidden page pauses pending sync; review and disabled responses never automatically poll',async()=>{
 const r=await syncing([pendingSync]);await r.visibility(true);assert.equal(r.timers.size,0);assert.equal(r.calls.length,1);
 await r.visibility(false);assert.equal(r.timers.size,1);
 for(const context of [{ok:true,bookingEnabled:false,crmPending:false,reason:'contact_sync_pending'},{ok:true,bookingEnabled:false,crmPending:false,reason:'sales_review_required'},{ok:true,bookingEnabled:false,reason:'calendar_integration_pending'}]) {
  const stopped=await syncing([context]);assert.equal(stopped.timers.size,0);assert.equal(stopped.calls.length,1);
 }
});
test('context API reports polling only for pending delivery on an enabled eligible open cycle',async()=>{
 const apiScript=fs.readFileSync(require('node:path').join(__dirname,'../api/booking-context.js'),'utf8');
 const base={id:'application',cycle_id:'cycle',cycle_status:'open',cycle_stage:'unbooked',crm_status:'pending'};
 for(const [patch,enabled,pending] of [[{},true,true],[{},false,false],[{crm_status:'failed'},true,false],[{crm_status:null},true,false],[{cycle_status:'won'},true,false],[{cycle_stage:'legacy_review'},true,false],[{cycle_stage:'customer_review'},true,false]]) {
  const module={exports:{}};
  vm.runInNewContext(apiScript,{module,require(name){if(name.endsWith('attribution-booking'))return {contextFor:async()=>({...base,...patch}),config:()=>({enabled})};if(name.endsWith('attribution-db'))return {query:async()=>({rows:[]})};if(name.endsWith('attribution-http'))return {fail(){throw Error('unexpected failure');}};return {InputError:Error};}});
  let body;await module.exports({method:'GET',query:{ref:'opaque'}},{setHeader(){},status(){return this;},json(value){body=value;}});
  assert.equal(body.crmPending,pending);assert.equal(body.bookingEnabled,false);
  if(pending)assert.equal(body.reason,'contact_sync_pending');
 }
});

test('newer canonical appointment changes discard old attempt and read context without another booking POST',async()=>{
 for(const state of ['cancelled','showed','noshow']) {
  const oldId=require('node:crypto').randomUUID();
  const time=new Date(Date.now()+86400000).toISOString();
  const r=await interactive({contexts:[null,{bookingId:oldId,startTime:time,timezone:'UTC',state,canRetry:false}],posts:[{ok:false,status:409,body:{ok:false,error:'appointment_changed'}},{ok:true,status:202,body:{ok:true,pending:true}}]});
  await r.choose();await r.confirm();
  const original=JSON.parse(r.calls.find(c=>c.url==='/api/bookings').config.body);
  assert.equal(r.calls.filter(c=>c.url==='/api/bookings').length,1);
  assert.equal(r.calls.filter(c=>c.url.startsWith('/api/booking-context')).length,2);
  assert.notEqual(r.elements['#booking-heading'].textContent,'Your call is booked.');
  if(state==='cancelled') {
   assert.match(r.elements['#booking-heading'].textContent,/no longer booked/);
   assert.equal(r.elements['#booking-picker'].hidden,false);
   assert.equal(r.elements['#booking-timezone'].disabled,false);
   await r.choose();await r.confirm();
   const posts=r.calls.filter(c=>c.url==='/api/bookings');
   assert.equal(posts.length,2);assert.notEqual(JSON.parse(posts[1].config.body).bookingId,original.bookingId);
  } else {
   assert.equal(r.elements['#booking-picker'].hidden,true);
   assert.match(r.elements['#booking-detail'].textContent,/next step/);
   await r.confirm();assert.equal(r.calls.filter(c=>c.url==='/api/bookings').length,1);
  }
 }
});
