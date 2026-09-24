const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const creation=require('../../lib/opportunity-creation');
module.exports=async function validateBookingCycle(db){
 assert.match((await db.query('SELECT current_schema() AS name')).rows[0].name,/^sog_test_[0-9a-f]{32}$/);
 const contactId=randomUUID(),ghlId='booking-fixture-'+randomUUID(),now=Date.now();
 await db.query('INSERT INTO sog_contacts(id,email,ghl_contact_id,first_touch,latest_touch) VALUES($1,$2,$3,$4,$5)',[contactId,contactId+'@example.invalid',ghlId,{source:'meetup',medium:'offline'},{source:'google',medium:'cpc'}]);
 const one={eventId:randomUUID(),appointmentId:'booking-'+randomUUID(),contactId:ghlId,calendarId:'fixture-calendar',status:'confirmed',startsAt:new Date(now+86400000).toISOString(),updatedAt:new Date(now).toISOString()};
 const two={...one,eventId:randomUUID(),appointmentId:'booking-'+randomUUID(),updatedAt:new Date(now+1000).toISOString()};
 await Promise.all([db.saveAppointment(one),db.saveAppointment(two),db.saveAppointment(one)]);
 const {rows:cycles}=await db.query('SELECT * FROM sog_sales_cycles WHERE contact_id=$1',[contactId]);assert.equal(cycles.length,1);assert.equal(cycles[0].stage,'booked');
 const {rows:appointments}=await db.query('SELECT * FROM sog_appointments WHERE contact_id=$1',[contactId]);assert.equal(appointments.length,2);assert.ok(appointments.every(row=>row.cycle_id===cycles[0].id));
 assert.ok(appointments.every(row=>row.attribution.firstTouch.source==='meetup'));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_applications WHERE contact_id=$1',[contactId])).rows[0].n,0);
 const queued=(await db.query("SELECT count(*)::int AS n FROM sog_outbox WHERE type='appointment' AND payload->>'cycleId'=$1",[cycles[0].id])).rows[0].n;
 assert.ok(queued>=1 && queued<=2); // Older booking arriving second is intentionally superseded.
 assert.equal((await db.query('SELECT 1 FROM sog_outbox WHERE event_id=$1',[two.eventId])).rowCount,1);
 // Independent reservation pool commits through parent outbox rollback and never
 // needs the sales-cycle row lock held by the caller.
 let first;
 await assert.rejects(db.transaction(async c=>{
  await c.query('SELECT * FROM sog_sales_cycles WHERE id=$1 FOR UPDATE',[cycles[0].id]);
  first=await creation.reserve(cycles[0].id,ghlId);assert.equal(first,true);
  throw new Error('intentional_fixture_rollback');
 }),{message:'intentional_fixture_rollback'});
 const reservations=await Promise.all(Array.from({length:6},()=>creation.reserve(cycles[0].id,ghlId)));
 assert.ok(reservations.every(value=>value===false));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM sog_opportunity_creation_attempts WHERE cycle_id=$1',[cycles[0].id])).rows[0].n,1);
 return ['concurrent bookings without quiz reuse one booked cycle and retain canonical routing for the newest appointment','independent closer creation reservation survives delivery rollback and prevents duplicate POST authorization'];
};
