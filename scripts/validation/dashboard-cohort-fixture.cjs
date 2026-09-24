const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {funnelSQL,setterSQL}=require('../../api/dashboard/stats');
// Transaction rollback keeps this synthetic dataset out of every other fixture.
module.exports=async function dashboardCohortFixture(db){
 const c=await db.getPool().connect();
 try {
  await c.query('BEGIN');
  const start='2030-01-01T00:00:00Z',end='2030-02-01T00:00:00Z';
  const touch=(source,medium='organic_social',campaign='launch')=>({firstTouch:{source,medium,utm_campaign:campaign},latestTouch:{source:'different_latest_source',medium:'paid_social',utm_campaign:'retargeting'}});
  async function person(){const id=randomUUID();await c.query("INSERT INTO sog_contacts(id,email,first_touch,latest_touch) VALUES($1,$2,'{}','{}')",[id,id+'@example.invalid']);return id;}
  async function journey(){const id=randomUUID();await c.query("INSERT INTO sog_journeys(id,first_touch,latest_touch) VALUES($1,'{}','{}')",[id]);return id;}
  async function cycle(person,status){const id=randomUUID();await c.query("INSERT INTO sog_sales_cycles(id,contact_id,status,stage,created_at) VALUES($1,$2,$3,'unbooked','2030-01-01')",[id,person,status]);return id;}
  async function event(person,type,at,payload={}){const id=randomUUID();await c.query('INSERT INTO sog_events(event_id,type,contact_id,occurred_at,payload) VALUES($1,$2,$3,$4,$5)',[id,type,person,at,payload]);return id;}
  async function lead(person,at,attribution){const id=await event(person,'lead_captured',at),j=await journey(),lc=randomUUID();await c.query("INSERT INTO sog_lead_cycles(id,contact_id,entry_offer) VALUES($1,$2,'newsletter')",[lc,person]);await c.query("INSERT INTO sog_lead_captures(id,contact_id,journey_id,lead_cycle_id,offer,profile,consent,attribution,created_at) VALUES($1,$2,$3,$4,'newsletter','{}','{}',$5,$6)",[id,person,j,lc,attribution,at]);}
  async function app(person,cy,at,attribution){const id=await event(person,'quiz_submitted',at),j=await journey();await c.query("INSERT INTO sog_applications(id,contact_id,journey_id,cycle_id,quiz_version,answers,consent,attribution,created_at) VALUES($1,$2,$3,$4,'test','{}','{}',$5,$6)",[id,person,j,cy,attribution,at]);}
  async function booking(person,cy,at,attribution,setter,status='confirmed'){const id=randomUUID();await c.query("INSERT INTO sog_appointments(id,contact_id,cycle_id,calendar_id,status,starts_at,updated_at,attribution,booking_setter_id) VALUES($1,$2,$3,'test',$4,'2030-02-05',$5,$6,$7)",[id,person,cy,status,at,attribution,setter]);await event(person,'appointment_confirmed',at,{appointmentId:id});return id;}
  const a=await person(),al=await cycle(a,'lost'),aw=await cycle(a,'won');
  await lead(a,'2030-01-02',touch('meetup','offline'));
  await app(a,al,'2030-01-03',touch('google','cpc'));await app(a,aw,'2030-01-06',touch('youtube'));
  const cancelled=await booking(a,al,'2030-01-04',touch('google'),'setter_a','cancelled');
  await event(a,'appointment_confirmed','2030-01-05',{appointmentId:cancelled}); // reschedule cannot add a booking
  const wonBooking=await booking(a,aw,'2030-01-07',touch('youtube'),'setter_b');
  const b=await person(),bw=await cycle(b,'won');await app(b,bw,'2030-01-04',touch('youtube'));
  const direct=await person(),cw=await cycle(direct,'won');await booking(direct,cw,'2030-01-05',{},null);
  const d=await person(),dc=await cycle(d,'open');await lead(d,'2030-01-06',touch('facebook'));await app(d,dc,'2030-02-02',touch('facebook'));
  const old=await person(),oc=await cycle(old,'open');await lead(old,'2029-12-31',touch('old'));await app(old,oc,'2030-01-09',touch('google'));
  const {rows:[result]}=await c.query(funnelSQL(true),[start,end]);const f=result.report;
  assert.deepEqual(f.summary,{leads:4,qualified:3,booked:2,won:2,totalWon:3,wonWithoutVerifiedBooking:1});
  assert.deepEqual(f.coverage,{leadCaptureIncluded:true,leadCaptureEntry:2,quizEntry:1,directBookingEntry:1,qualifiedWithoutQuiz:1,unknownSource:1});
  assert.deepEqual(f.channels.find(x=>x.source==='meetup'),{source:'meetup',medium:'offline',leads:1,qualified:1,booked:1,won:1,total_won:1});
  assert.equal(f.channels.some(x=>['old','google','different_latest_source'].includes(x.source)),false);
  assert.equal(f.campaigns.reduce((n,x)=>n+x.leads,0),4);
  const {rows:[credit]}=await c.query(setterSQL(false),[start,end]);
  assert.equal(credit.report.bookings,3);assert.equal(credit.report.unknownBookings,1);
  assert.equal(credit.report.rows.find(x=>x.setter_id==='setter_a').won_contacts,0);
  assert.equal(credit.report.rows.find(x=>x.setter_id==='setter_b').won_contacts,1);
  assert.equal(credit.report.rows.find(x=>x.setter_id===null).evidence,'unknown');
  assert.equal(credit.report.rows.find(x=>x.setter_id==='setter_a').evidence,'recorded_credit_unverified_provenance');
  await c.query("INSERT INTO sog_booking_setter_credits(appointment_id,setter_id,evidence_type,request_id,reason,admin_session_hash,provider_revision) VALUES($1,'setter_b','admin_attested',$2,'Verified test setter evidence',$3,'2030-01-07')",[wonBooking,randomUUID(),'a'.repeat(64)]);
  const {rows:[attested]}=await c.query(setterSQL(true),[start,end]);
  assert.equal(attested.report.rows.find(x=>x.setter_id==='setter_b').evidence,'admin_attested');
  assert.equal(attested.report.rows.find(x=>x.setter_id==='setter_a').evidence,'recorded_credit_unverified_provenance');
  const {rows:[partial]}=await c.query(funnelSQL(false),[start,end]);
  assert.equal(partial.report.coverage.leadCaptureIncluded,false); // omitted feature history is explicit
  return ['cohort first-touch acquisition, repeated submissions/cycles, direct bookings, unbooked wins and old-contact exclusion','setter appointment identity, reschedule deduplication, cancellation history, unknown and provenance coverage'];
 } finally {await c.query('ROLLBACK');c.release();}
};
