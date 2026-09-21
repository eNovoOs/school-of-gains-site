const { randomUUID } = require('node:crypto');
const { mergeTouches, nextStage, InputError } = require('./attribution');
let pool;
function getPool() {
  if (!process.env.DATABASE_URL) throw new InputError('storage_unavailable',503);
  if (!pool) { const { Pool } = require('pg'); pool = new Pool({ connectionString:process.env.DATABASE_URL, max:3, idleTimeoutMillis:10000, connectionTimeoutMillis:5000 }); }
  return pool;
}
const query = (sql, params) => getPool().query(sql,params);
async function transaction(fn) { const c = await getPool().connect(); try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } }
async function journey(c, id, attr) {
  await c.query('INSERT INTO sog_journeys(id,first_touch,latest_touch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,attr.firstTouch,attr.latestTouch]);
  const { rows:[old] } = await c.query('SELECT * FROM sog_journeys WHERE id=$1 FOR UPDATE',[id]);
  const merged = mergeTouches({ firstTouch:old.first_touch,latestTouch:old.latest_touch },attr);
  await c.query('UPDATE sog_journeys SET latest_touch=$2 WHERE id=$1',[id,merged.latestTouch]);
  return merged;
}
async function saveEvent(input) { return transaction(async c => {
  await journey(c,input.journeyId,input.attribution);
  const { rowCount } = await c.query('INSERT INTO sog_events(event_id,type,journey_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.eventId,input.type,input.journeyId,{path:input.path,attribution:input.attribution}]);
  return { duplicate:rowCount === 0 };
}); }
async function saveApplication(input) { return transaction(async c => {
  // Serialize submissions per normalized identity; also protects active-cycle creation.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.contact.email]);
  const duplicate = await c.query('SELECT a.id,c.email FROM sog_applications a JOIN sog_contacts c ON c.id=a.contact_id WHERE a.id=$1',[input.submissionId]);
  if (duplicate.rowCount) { if (duplicate.rows[0].email !== input.contact.email) throw new InputError('idempotency_conflict',409); return { applicationId:input.submissionId, duplicate:true }; }
  const attr = await journey(c,input.journeyId,input.attribution);
  await c.query('INSERT INTO sog_contacts(id,email,first_touch,latest_touch) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING',[randomUUID(),input.contact.email,attr.firstTouch,attr.latestTouch]);
  const { rows:[contact] } = await c.query('SELECT * FROM sog_contacts WHERE email=$1 FOR UPDATE',[input.contact.email]);
  const snapshot = mergeTouches({firstTouch:contact.first_touch,latestTouch:contact.latest_touch},attr);
  await c.query('UPDATE sog_contacts SET latest_touch=$2 WHERE id=$1',[contact.id,snapshot.latestTouch]);
  let { rows:[cycle] } = await c.query("SELECT * FROM sog_sales_cycles WHERE contact_id=$1 AND offer_id='apprentice' AND status IN ('open','review') FOR UPDATE",[contact.id]);
  if (!cycle) {
    const won = await c.query("SELECT 1 FROM sog_sales_cycles WHERE contact_id=$1 AND status='won' LIMIT 1",[contact.id]);
    const created = await c.query('INSERT INTO sog_sales_cycles(id,contact_id,status,stage) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),contact.id,won.rowCount?'review':'open',won.rowCount?'customer_review':'unbooked']); cycle = created.rows[0];
  }
  await c.query('INSERT INTO sog_events(event_id,type,journey_id,contact_id,payload) VALUES($1,$2,$3,$4,$5)',[input.submissionId,'quiz_submitted',input.journeyId,contact.id,{quizVersion:input.quizVersion,attribution:snapshot}]);
  await c.query('INSERT INTO sog_applications(id,contact_id,journey_id,cycle_id,quiz_version,answers,consent,attribution) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[input.submissionId,contact.id,input.journeyId,cycle.id,input.quizVersion,input.answers,input.consent,snapshot]);
  await c.query('INSERT INTO sog_outbox(event_id,type,payload) VALUES($1,$2,$3)',[input.submissionId,'application',{...input,attribution:snapshot,contactId:contact.id,cycleId:cycle.id}]);
  return {applicationId:input.submissionId,duplicate:false};
}); }
async function saveAppointment(input) { return transaction(async c => {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.appointmentId]);
  if ((await c.query('SELECT 1 FROM sog_events WHERE event_id=$1',[input.eventId])).rowCount) return {duplicate:true};
  const {rows:[contact]} = await c.query('SELECT * FROM sog_contacts WHERE ghl_contact_id=$1 FOR UPDATE',[input.contactId]);
  if (!contact) throw new InputError('contact_not_linked_retry',409);
  const {rows:[old]} = await c.query('SELECT * FROM sog_appointments WHERE id=$1',[input.appointmentId]);
  await c.query('INSERT INTO sog_events(event_id,type,contact_id,occurred_at,payload) VALUES($1,$2,$3,$4,$5)',[input.eventId,'appointment_'+input.status,contact.id,input.updatedAt,input]);
  if (old && Date.parse(old.updated_at) >= Date.parse(input.updatedAt)) return {stale:true};
  // Existing appointments stay with their original cycle after a loss/reapply.
  // A late cancellation must never mutate a different, newly opened sales cycle.
  const cycleResult = old?.cycle_id
    ? await c.query('SELECT * FROM sog_sales_cycles WHERE id=$1 FOR UPDATE',[old.cycle_id])
    : input.applicationId
      ? await c.query('SELECT sc.* FROM sog_sales_cycles sc JOIN sog_applications a ON a.cycle_id=sc.id WHERE a.id=$1 AND sc.contact_id=$2 FOR UPDATE OF sc',[input.applicationId,contact.id])
      : await c.query("SELECT * FROM sog_sales_cycles WHERE contact_id=$1 AND offer_id='apprentice' AND status IN ('open','review') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[contact.id]);
  const cycle=cycleResult.rows[0];
  const snapshot = old?.attribution || input.attribution || {firstTouch:contact.first_touch,latestTouch:contact.latest_touch};
  await c.query('INSERT INTO sog_appointments(id,contact_id,cycle_id,calendar_id,status,starts_at,updated_at,attribution,booking_setter_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,starts_at=EXCLUDED.starts_at,updated_at=EXCLUDED.updated_at,booking_setter_id=COALESCE(sog_appointments.booking_setter_id,EXCLUDED.booking_setter_id)',[input.appointmentId,contact.id,cycle?.id || null,input.calendarId,input.status,input.startsAt,input.updatedAt,snapshot,input.bookingSetterId]);
  if(['cancelled','invalid'].includes(input.status)) await c.query("UPDATE sog_booking_intents SET state='cancelled',updated_at=now() WHERE appointment_id=$1",[input.appointmentId]);
  if (cycle && cycle.status === 'open') {
    // A cancellation for an older appointment must not undo a newer booking.
    const isNegative=['cancelled','invalid','noshow'].includes(input.status);
    const newer = await c.query("SELECT 1 FROM sog_appointments WHERE cycle_id=$1 AND id<>$2 AND status IN ('new','confirmed','showed') AND ($4::boolean OR updated_at>$3) LIMIT 1",[cycle.id,input.appointmentId,input.updatedAt,isNegative]);
    if (!newer.rowCount) {
      await c.query('UPDATE sog_sales_cycles SET stage=$2,booking_setter_id=COALESCE($3,booking_setter_id) WHERE id=$1',[cycle.id,nextStage(cycle,input.status),['new','confirmed'].includes(input.status)?input.bookingSetterId:null]);
      await c.query('INSERT INTO sog_outbox(event_id,type,payload) VALUES($1,$2,$3)',[input.eventId,'appointment',{cycleId:cycle.id,appointmentId:input.appointmentId}]);
    }
  }
  return {duplicate:false};
}); }
async function saveOpportunity(input) { return transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.opportunityId]);
  if((await c.query('SELECT 1 FROM sog_events WHERE event_id=$1',[input.eventId])).rowCount) return {duplicate:true};
  const {rows:[cycle]}=await c.query('SELECT * FROM sog_sales_cycles WHERE ghl_opportunity_id=$1 FOR UPDATE',[input.opportunityId]);
  if(!cycle) throw new InputError('opportunity_not_linked_retry',409);
  await c.query('INSERT INTO sog_events(event_id,type,contact_id,occurred_at,payload) VALUES($1,$2,$3,$4,$5)',[input.eventId,'opportunity_'+input.status,cycle.contact_id,input.updatedAt,input]);
  if(cycle.provider_updated_at && Date.parse(cycle.provider_updated_at)>=Date.parse(input.updatedAt)) return {stale:true};
  if(['won','lost'].includes(cycle.status) && input.status==='open') return {review:true};
  let stages;try{stages=JSON.parse(process.env.GHL_STAGE_IDS_JSON || '{}');}catch{throw new InputError('stage_mapping_invalid',503);}
  const mapped=Object.entries(stages).find(([,id])=>id===input.pipelineStageId)?.[0];
  const stage=input.status==='open'?(mapped || 'legacy_review'):input.status;
  await c.query('UPDATE sog_sales_cycles SET status=$2,stage=$3,provider_updated_at=$4 WHERE id=$1',[cycle.id,input.status,stage,input.updatedAt]);
  return {duplicate:false};
}); }
async function rateLimit(key, limit) {
  const {rows:[row]} = await query("INSERT INTO sog_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN sog_rate_limits.expires_at<now() THEN 1 ELSE sog_rate_limits.count+1 END,expires_at=CASE WHEN sog_rate_limits.expires_at<now() THEN now()+interval '1 minute' ELSE sog_rate_limits.expires_at END RETURNING count",[key]);
  if (row.count > limit) throw new InputError('rate_limited',429);
}
module.exports = {getPool,query,transaction,saveEvent,saveApplication,saveAppointment,saveOpportunity,rateLimit};
