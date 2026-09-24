const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalize}=require('../lib/ghl-signal');
const booking=require('../lib/attribution-booking');
// Active sales calendars in the September 21 provider audit; no personal/test calendars.
const calendars=['kQHIe9WY8PjSAl11jSjc','fmngwEFNUSNHgRgTcSw0','HOZWlZZhl5IrrwCldrzo','8zbIfhmSbuYK9x3gHliJ','oReAJdD6Z9edNINB6I75'];
function env(t,values){const prior={...process.env};Object.assign(process.env,values);t.after(()=>{for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);});}
test('all five explicitly approved sales calendars preserve provider lifecycle and never infer setter credit',async t=>{
 env(t,{GHL_CALENDAR_IDS:calendars.join(', ')});
 for(const calendarId of calendars)for(const status of ['new','confirmed','cancelled','showed','noshow','invalid']){
  const event={id:'appointment1',locationId:'3mi3YQaZvtUMZzaQUuL6',contactId:'contact1',calendarId,appointmentStatus:status,startTime:'2026-09-28T15:00:00-04:00',dateUpdated:'2026-09-21T12:00:00Z',assignedUserId:'closer',bookingSetterId:'untrusted'};
  const input={kind:'appointment',resourceId:event.id,contactId:event.contactId};
  const value=await normalize(input,async()=>({appointment:event}));
  assert.equal(value.calendarId,calendarId);assert.equal(value.status,status);assert.equal(value.bookingSetterId,null);assert.equal(value.startsAt,'2026-09-28T19:00:00.000Z');
  const again=await normalize(input,async()=>({appointment:event}));assert.equal(value.eventId,again.eventId);
 }
});
test('public booking remains on its configured calendar and whitespace cannot disable it',t=>{
 env(t,{GHL_CALENDAR_IDS:calendars.join(', '),GHL_BOOKING_CALENDAR_ID:calendars[3],GHL_BOOKING_ENABLED:'true',GHL_SYNC_ENABLED:'true',GHL_PRIVATE_INTEGRATION_TOKEN:'test-only'});
 assert.deepEqual(booking.config(),{calendarId:calendars[3],enabled:true});
 process.env.GHL_BOOKING_CALENDAR_ID='unapproved';assert.equal(booking.config().enabled,false);
});
test('sales calendar inventory grants no implicit runtime permission',async t=>{
 env(t,{GHL_CALENDAR_IDS:calendars[0]});
 for(const calendarId of [...calendars.slice(1),'Uwywbt23ZLhctTs9VZvg','e2uWb8go7RN1QXEsKdrJ']){
  await assert.rejects(normalize({kind:'appointment',resourceId:'a'},async()=>({appointment:{id:'a',locationId:'3mi3YQaZvtUMZzaQUuL6',contactId:'c',calendarId}})),/calendar_not_allowed/);
 }
});
