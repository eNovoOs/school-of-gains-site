const test=require('node:test'),assert=require('node:assert/strict');
const db=require('../lib/attribution-db'),booking=require('../lib/attribution-booking');
test('booking context uses current appointment state while retaining immutable intent identity',async()=>{
 const old={query:db.query,contextFor:booking.contextFor,config:booking.config};
 const original='2026-10-01T12:00:00Z',rescheduled='2026-10-03T15:00:00Z';
 let context={id:'application',cycle_id:'cycle',ghl_contact_id:'contact',crm_status:'delivered',cycle_status:'open',cycle_stage:'booked',ghl_opportunity_id:'opp'};
 let intent={id:'booking',application_id:'application',start_time:original,timezone:'America/Toronto',state:'confirmed',appointment_start:rescheduled,appointment_status:'confirmed'};
 booking.contextFor=async()=>context;booking.config=()=>({enabled:true});
 db.query=async sql=>{assert.ok(sql.includes('LEFT JOIN sog_appointments'));assert.ok(!sql.startsWith('UPDATE'));return {rows:[intent]};};
 const routePath=require.resolve('../api/booking-context');delete require.cache[routePath];const handler=require(routePath);
 async function invoke(){let result;const res={setHeader(){},status(code){assert.equal(code,200);return this;},json(body){result=body;}};await handler({method:'GET',query:{ref:'signed'}},res);return result;}
 try{
  let result=await invoke();assert.equal(result.existingBooking.startTime,new Date(rescheduled).toISOString());assert.equal(result.existingBooking.originalStartTime,new Date(original).toISOString());assert.equal(result.existingBooking.canRetry,false);
  for(const status of ['cancelled','invalid','showed','noshow']){intent.appointment_status=status;result=await invoke();assert.equal(result.existingBooking.state,status);assert.equal(result.existingBooking.canRetry,false);}
  intent={...intent,state:'uncertain',appointment_status:undefined,appointment_start:undefined};result=await invoke();assert.equal(result.existingBooking.startTime,new Date(original).toISOString());assert.equal(result.existingBooking.canRetry,true);
  context={...context,cycle_status:'review',ghl_opportunity_id:null};result=await invoke();assert.equal(result.bookingEnabled,false);assert.equal(result.reason,'sales_review_required');
 }finally{Object.assign(db,{query:old.query});Object.assign(booking,{contextFor:old.contextFor,config:old.config});delete require.cache[routePath];}
});
