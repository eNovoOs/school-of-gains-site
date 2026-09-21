const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const assert = (ok, message) => { if (!ok) throw new InputError(message); };
function text(value, max = 200) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function safeUrl(value) { try { const u = new URL(value); if (!['https:', 'http:'].includes(u.protocol)) return ''; return u.origin + u.pathname; } catch { return ''; } }
function touch(value, now = new Date()) {
  const v = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const k of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id','gclid','fbclid','gbraid','wbraid','ttclid']) if (text(v[k])) result[k] = text(v[k]);
  result.landing_page = safeUrl(v.landing_page);
  result.referrer = safeUrl(v.referrer);
  const timestamp = Date.parse(v.captured_at);
  result.captured_at = Number.isFinite(timestamp) && timestamp <= now.getTime() + 300000 && timestamp >= now.getTime() - 30 * 86400000 ? new Date(timestamp).toISOString() : now.toISOString();
  result.source = result.utm_source?.toLowerCase() || (result.gclid || result.gbraid || result.wbraid ? 'google' : result.fbclid ? 'facebook' : 'direct');
  result.medium = result.utm_medium?.toLowerCase() || (result.gclid || result.gbraid || result.wbraid ? 'cpc' : 'unknown');
  if (!result.utm_source && !result.gclid && !result.gbraid && !result.wbraid && !result.fbclid && result.referrer) {
    const host = new URL(result.referrer).hostname;
    if (!/(^|\.)school-of-gains\.com$/.test(host)) {
      result.source = /(^|\.)google\.[a-z.]+$/.test(host) ? 'google' : host;
      result.medium = result.source === 'google' ? 'organic' : 'referral';
    }
  }
  result.confidence = result.utm_source ? 'explicit' : result.source === 'direct' ? 'unknown' : 'inferred';
  result.model = 'sog-v1';
  return result;
}
function attribution(value, now) { return { firstTouch: touch(value?.firstTouch || value, now), latestTouch: touch(value?.latestTouch || value, now) }; }
function mergeTouches(existing, incoming) {
  return { firstTouch: existing?.firstTouch || incoming.firstTouch, latestTouch: !existing?.latestTouch || (incoming.latestTouch.source !== 'direct' && Date.parse(incoming.latestTouch.captured_at) >= Date.parse(existing.latestTouch.captured_at)) ? incoming.latestTouch : existing.latestTouch };
}
function application(body) {
  assert(body && typeof body === 'object', 'invalid_body');
  assert(UUID.test(body.submissionId || '') && UUID.test(body.journeyId || ''), 'invalid_id');
  assert(body.quizVersion === 'apprentice-v1', 'unsupported_quiz_version');
  assert(!body.website, 'invalid_submission');
  const email = text(body.contact?.email, 254).toLowerCase();
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'invalid_email');
  const firstName = text(body.contact?.firstName, 100); assert(firstName, 'first_name_required');
  const phone = text(body.contact?.phone, 30); assert(!phone || /^\+?[\d ()-]{7,30}$/.test(phone), 'invalid_phone');
  assert(body.consent?.privacy === true, 'privacy_consent_required');
  assert(body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers), 'answers_required');
  const options = {
    ageRange:['under_18','18_29','30_39','40_49','50_64','65_plus'],
    weeklyTime:['3_5_hours','5_10_hours','10_plus_hours','not_sure'],
    educationBudget:['1500_3500','3500_5500','5500_plus','not_ready'],
    attendance:['yes','unsure']
  };
  const answers = {};
  assert(Object.keys(body.answers).every(k => [...Object.keys(options),'goals','notes'].includes(k)), 'unknown_answer');
  for(const [key,values] of Object.entries(options)) { assert(values.includes(body.answers[key]), 'invalid_'+key); answers[key]=body.answers[key]; }
  const goals = body.answers.goals;
  assert(Array.isArray(goals) && goals.length>=1 && goals.length<=6 && goals.every(g=>['understand_markets','build_system','market_drivers','confidence','full_education','exploring'].includes(g)), 'invalid_goals');
  answers.goals = [...new Set(goals)];
  assert(body.answers.notes === undefined || (typeof body.answers.notes === 'string' && body.answers.notes.length <= 2000), 'invalid_notes');
  answers.notes = text(body.answers.notes,2000);
  return { submissionId: body.submissionId, journeyId: body.journeyId, quizVersion: body.quizVersion, contact: { email, firstName, lastName: text(body.contact?.lastName,100), phone }, answers, consent: { privacy: true, marketing: body.consent.marketing === true }, attribution: attribution(body.attribution) };
}
function event(body) {
  assert(UUID.test(body?.eventId || '') && UUID.test(body?.journeyId || ''), 'invalid_id');
  assert(['page_view','quiz_started'].includes(body.type), 'invalid_event_type');
  assert(typeof body.path === 'string' && /^\/[a-zA-Z0-9/_-]*$/.test(body.path) && body.path.length <= 200, 'invalid_path');
  return { eventId: body.eventId, journeyId: body.journeyId, type: body.type, path: body.path, attribution: attribution(body.attribution) };
}
function secureEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x,y); }
function appointment(body) {
  assert(UUID.test(body?.eventId || ''), 'invalid_event_id');
  assert(body.locationId === '3mi3YQaZvtUMZzaQUuL6', 'invalid_location');
  assert(['new','confirmed','cancelled','showed','noshow','invalid'].includes(body.status), 'invalid_status');
  for (const key of ['appointmentId','contactId','calendarId']) assert(/^[a-zA-Z0-9_-]{1,100}$/.test(body[key] || ''), 'invalid_' + key);
  assert(Number.isFinite(Date.parse(body.updatedAt)) && Number.isFinite(Date.parse(body.startsAt)), 'invalid_timestamp');
  return { eventId:body.eventId, locationId:body.locationId, appointmentId:body.appointmentId, contactId:body.contactId, calendarId:body.calendarId, status:body.status, updatedAt:new Date(body.updatedAt).toISOString(), startsAt:new Date(body.startsAt).toISOString(), bookingSetterId:text(body.bookingSetterId,100) || null };
}
function opportunity(body) {
  assert(UUID.test(body?.eventId || ''), 'invalid_event_id');
  assert(body.locationId === '3mi3YQaZvtUMZzaQUuL6' && body.pipelineId === 'GxJOcIsgv7Svx90E2BZr', 'invalid_pipeline');
  assert(['open','won','lost'].includes(body.status), 'invalid_status');
  for(const key of ['opportunityId','pipelineStageId']) assert(/^[a-zA-Z0-9_-]{1,100}$/.test(body[key] || ''), 'invalid_'+key);
  assert(Number.isFinite(Date.parse(body.updatedAt)), 'invalid_timestamp');
  return {eventId:body.eventId,opportunityId:body.opportunityId,pipelineStageId:body.pipelineStageId,status:body.status,updatedAt:new Date(body.updatedAt).toISOString()};
}
function nextStage(current, appointmentStatus) {
  if (['won','lost'].includes(current.status)) return current.stage;
  if (['call_held','follow_up'].includes(current.stage) && ['new','confirmed'].includes(appointmentStatus)) return current.stage;
  return ({new:'booked',confirmed:'booked',cancelled:'unbooked',showed:'call_held',noshow:'no_show',invalid:'unbooked'})[appointmentStatus];
}
module.exports = { InputError, assert, application, event, appointment, opportunity, attribution, mergeTouches, touch, secureEqual, nextStage };
