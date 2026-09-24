const auth = require('../../lib/dashboard-auth');
const { query } = require('../../lib/attribution-db');
// All aggregates come from the new event ledger. No stage-based booking inference.
const SQL = `
WITH booking_events AS (
 SELECT payload->>'appointmentId' AS appointment_id, min(occurred_at) AS first_booked_at
 FROM sog_events WHERE type IN ('appointment_new','appointment_confirmed')
 GROUP BY payload->>'appointmentId'
), applications AS (
 SELECT COALESCE(NULLIF(attribution->'latestTouch'->>'source',''),NULLIF(attribution->'latestTouch'->>'utm_source',''),'unknown') AS source,
 COALESCE(NULLIF(attribution->'latestTouch'->>'medium',''),NULLIF(attribution->'latestTouch'->>'utm_medium',''),'unknown') AS medium,
 COALESCE(NULLIF(attribution->'latestTouch'->>'utm_campaign',''),'(not set)') AS campaign,
 COALESCE(NULLIF(attribution->'latestTouch'->>'utm_content',''),'(not set)') AS content
 FROM sog_applications WHERE created_at >= $1 AND created_at < $2
), bookings AS (
 SELECT COALESCE(NULLIF(a.attribution->'latestTouch'->>'source',''),NULLIF(a.attribution->'latestTouch'->>'utm_source',''),'unknown') AS source,
 COALESCE(NULLIF(a.attribution->'latestTouch'->>'medium',''),NULLIF(a.attribution->'latestTouch'->>'utm_medium',''),'unknown') AS medium,
 COALESCE(NULLIF(a.attribution->'latestTouch'->>'utm_campaign',''),'(not set)') AS campaign,
 COALESCE(NULLIF(a.attribution->'latestTouch'->>'utm_content',''),'(not set)') AS content,a.status
 FROM booking_events e JOIN sog_appointments a ON a.id=e.appointment_id
 WHERE e.first_booked_at >= $1 AND e.first_booked_at < $2
), channel_counts AS (
 SELECT source,medium,count(*) AS applications,0::bigint AS bookings FROM applications GROUP BY source,medium
 UNION ALL
 SELECT source,medium,0::bigint,count(*) FROM bookings GROUP BY source,medium
), channels AS (
 SELECT source,medium,sum(applications)::int AS applications,sum(bookings)::int AS bookings FROM channel_counts GROUP BY source,medium
), campaign_counts AS (
 SELECT source,medium,campaign,content,count(*) AS applications,0::bigint AS bookings FROM applications GROUP BY source,medium,campaign,content
 UNION ALL
 SELECT source,medium,campaign,content,0::bigint,count(*) FROM bookings GROUP BY source,medium,campaign,content
), campaigns AS (
 SELECT source,medium,campaign,content,sum(applications)::int AS applications,sum(bookings)::int AS bookings FROM campaign_counts GROUP BY source,medium,campaign,content
)
SELECT jsonb_build_object(
 'summary',jsonb_build_object(
 'visits',(SELECT count(DISTINCT journey_id)::int FROM sog_events WHERE type='page_view' AND occurred_at >= $1 AND occurred_at < $2),
 'applications',(SELECT count(*)::int FROM applications),
 'bookings',(SELECT count(*)::int FROM bookings),
 'attributedApplications',(SELECT count(*)::int FROM applications WHERE source NOT IN ('unknown','direct','(direct)'))),
 'channels',COALESCE((SELECT jsonb_agg(to_jsonb(channels) ORDER BY applications DESC,bookings DESC,source,medium) FROM channels),'[]'::jsonb),
 'campaigns',COALESCE((SELECT jsonb_agg(to_jsonb(campaigns) ORDER BY applications DESC,bookings DESC,source,medium,campaign,content) FROM campaigns),'[]'::jsonb),
 'outcomes',jsonb_build_object(
 'active',(SELECT count(*)::int FROM bookings WHERE status IN ('new','confirmed')),
 'cancelled',(SELECT count(*)::int FROM bookings WHERE status IN ('cancelled','invalid')),
 'attended',(SELECT count(*)::int FROM bookings WHERE status='showed'),
 'missed',(SELECT count(*)::int FROM bookings WHERE status='noshow'),
 'other',(SELECT count(*)::int FROM bookings WHERE status NOT IN ('new','confirmed','cancelled','invalid','showed','noshow') OR status IS NULL)),
 'health',jsonb_build_object(
 'openCycles',(SELECT count(*)::int FROM sog_sales_cycles WHERE status='open'),
 'unbookedCycles',(SELECT count(*)::int FROM sog_sales_cycles WHERE status='open' AND stage='unbooked'),
 'pendingDeliveries',(SELECT count(*)::int FROM sog_outbox WHERE status='pending'),
 'failedDeliveries',(SELECT count(*)::int FROM sog_outbox WHERE status='failed'),
 'pendingSignals',(SELECT count(*)::int FROM sog_provider_signals WHERE status='pending'),
 'failedSignals',(SELECT count(*)::int FROM sog_provider_signals WHERE status='failed'),
 'pendingBookingRecoveries',(SELECT count(*)::int FROM sog_booking_intents WHERE state IN ('pending','uncertain') AND recovery_status='pending'),
 'reviewBookingRecoveries',(SELECT count(*)::int FROM sog_booking_intents WHERE state IN ('pending','uncertain') AND recovery_status='review'),
 'lastBookingEvent',(SELECT max(received_at) FROM sog_events WHERE type IN ('appointment_new','appointment_confirmed')))
) AS report`;
// Person-level acquisition cohorts are separate from period submission/appointment volumes.
function funnelSQL(includeLeads=false) {
 const leadEntries=includeLeads ? `UNION ALL SELECT contact_id,created_at,0 AS priority,id::text AS tie,attribution,'lead_capture'::text AS entry FROM sog_lead_captures` : '';
 return `WITH booked AS (
 SELECT a.id,a.contact_id,a.cycle_id,a.booking_setter_id,a.attribution,min(e.occurred_at) AS booked_at
 FROM sog_appointments a JOIN sog_events e ON e.payload->>'appointmentId'=a.id
 WHERE e.type IN ('appointment_new','appointment_confirmed') AND e.occurred_at < $2
 GROUP BY a.id
 ), entries AS (
 SELECT contact_id,created_at,1 AS priority,id::text AS tie,attribution,'quiz'::text AS entry FROM sog_applications
 ${leadEntries}
 UNION ALL SELECT contact_id,booked_at,2,id,attribution,'direct_booking' FROM booked
 ), first_entry AS (
 SELECT DISTINCT ON(contact_id) * FROM entries ORDER BY contact_id,created_at,priority,tie
 ), cohort AS (
 SELECT f.contact_id,f.created_at,f.entry,
 COALESCE(NULLIF(f.attribution->'firstTouch'->>'source',''),NULLIF(f.attribution->'firstTouch'->>'utm_source',''),'unknown') AS source,
 COALESCE(NULLIF(f.attribution->'firstTouch'->>'medium',''),NULLIF(f.attribution->'firstTouch'->>'utm_medium',''),'unknown') AS medium,
 COALESCE(NULLIF(f.attribution->'firstTouch'->>'utm_campaign',''),'(not set)') AS campaign,
 EXISTS(SELECT 1 FROM sog_applications a WHERE a.contact_id=f.contact_id AND a.created_at < $2) AS quiz,
 EXISTS(SELECT 1 FROM booked b WHERE b.contact_id=f.contact_id) AS booked,
 EXISTS(SELECT 1 FROM sog_sales_cycles c WHERE c.contact_id=f.contact_id AND c.status='won' AND c.created_at < $2) AS any_won,
 EXISTS(SELECT 1 FROM sog_sales_cycles c JOIN booked b ON b.cycle_id=c.id AND b.contact_id=c.contact_id WHERE c.contact_id=f.contact_id AND c.status='won' AND c.created_at < $2) AS won
 FROM first_entry f WHERE f.created_at >= $1 AND f.created_at < $2
 ), people AS (SELECT *,quiz OR booked AS qualified FROM cohort),
 channels AS (SELECT source,medium,count(*)::int AS leads,count(*) FILTER(WHERE qualified)::int AS qualified,count(*) FILTER(WHERE booked)::int AS booked,count(*) FILTER(WHERE won)::int AS won,count(*) FILTER(WHERE any_won)::int AS total_won FROM people GROUP BY source,medium),
 campaigns AS (SELECT source,medium,campaign,count(*)::int AS leads,count(*) FILTER(WHERE qualified)::int AS qualified,count(*) FILTER(WHERE booked)::int AS booked,count(*) FILTER(WHERE won)::int AS won,count(*) FILTER(WHERE any_won)::int AS total_won FROM people GROUP BY source,medium,campaign)
 SELECT jsonb_build_object(
 'summary',jsonb_build_object('leads',count(*)::int,'qualified',count(*) FILTER(WHERE qualified)::int,'booked',count(*) FILTER(WHERE booked)::int,'won',count(*) FILTER(WHERE won)::int,'totalWon',count(*) FILTER(WHERE any_won)::int,'wonWithoutVerifiedBooking',count(*) FILTER(WHERE any_won AND NOT won)::int),
 'coverage',jsonb_build_object('leadCaptureIncluded',${includeLeads?'true':'false'},'leadCaptureEntry',count(*) FILTER(WHERE entry='lead_capture')::int,'quizEntry',count(*) FILTER(WHERE entry='quiz')::int,'directBookingEntry',count(*) FILTER(WHERE entry='direct_booking')::int,'qualifiedWithoutQuiz',count(*) FILTER(WHERE booked AND NOT quiz)::int,'unknownSource',count(*) FILTER(WHERE source='unknown')::int),
 'channels',COALESCE((SELECT jsonb_agg(to_jsonb(channels) ORDER BY leads DESC,source,medium) FROM channels),'[]'::jsonb),
 'campaigns',COALESCE((SELECT jsonb_agg(to_jsonb(campaigns) ORDER BY leads DESC,source,medium,campaign) FROM campaigns),'[]'::jsonb)
 ) AS report FROM people`;
}
function setterSQL(withEvidence=false) {
 return `WITH first_booked AS (
 SELECT payload->>'appointmentId' AS appointment_id,min(occurred_at) AS booked_at FROM sog_events
 WHERE type IN ('appointment_new','appointment_confirmed') GROUP BY payload->>'appointmentId'
 ), credited AS (
 SELECT a.id,a.contact_id,a.cycle_id,NULLIF(a.booking_setter_id,'') AS setter_id,
 CASE WHEN NULLIF(a.booking_setter_id,'') IS NULL THEN 'unknown'
 ${withEvidence?"WHEN credit.setter_id=a.booking_setter_id THEN credit.evidence_type":''}
 ELSE 'recorded_credit_unverified_provenance' END AS evidence,
 c.status='won' AS won
 FROM first_booked b JOIN sog_appointments a ON a.id=b.appointment_id LEFT JOIN sog_sales_cycles c ON c.id=a.cycle_id
 ${withEvidence?'LEFT JOIN sog_booking_setter_credits credit ON credit.appointment_id=a.id':''}
 WHERE b.booked_at >= $1 AND b.booked_at < $2
 ), setters AS (SELECT setter_id,evidence,count(*)::int AS bookings,count(DISTINCT contact_id)::int AS contacts,count(DISTINCT contact_id) FILTER(WHERE won)::int AS won_contacts FROM credited GROUP BY setter_id,evidence)
 SELECT jsonb_build_object('evidenceLedgerEnabled',${withEvidence?'true':'false'},'rows',COALESCE((SELECT jsonb_agg(to_jsonb(setters) ORDER BY bookings DESC,setter_id,evidence) FROM setters),'[]'::jsonb),'bookings',(SELECT count(*)::int FROM credited),'unknownBookings',(SELECT count(*)::int FROM credited WHERE setter_id IS NULL)) AS report`;
}
async function acquisitionReport(runQuery,range,flags=process.env) {
 const includeLeads=flags.LEAD_INTAKE_ENABLED==='true'||flags.GHL_LEAD_SIGNALS_ENABLED==='true';
 const [{rows:[funnel]},{rows:[setters]}]=await Promise.all([runQuery(funnelSQL(includeLeads),range),runQuery(setterSQL(flags.SETTER_CREDIT_ENABLED==='true'),range)]);
 if(Array.isArray(setters.report.rows)) {
  let roster=[];try{roster=require('../../lib/setter-credit').setterRoster(flags);}catch{/* Counts remain usable; IDs are explicit when no verified display roster is configured. */}
  const names=new Map(roster.map(person=>[person.id,person.name]));
  setters.report.rows=setters.report.rows.map(row=>({...row,setter_name:names.get(row.setter_id)||null}));
 }
 return {funnel:funnel.report,setters:setters.report};
}
// Build gated queries in JavaScript: CASE in SQL still resolves absent tables.
const LEAD_SQL=`SELECT jsonb_build_object(
 'distinctContacts',(SELECT count(DISTINCT contact_id)::int FROM sog_lead_captures WHERE created_at >= $1 AND created_at < $2),
 'captures',(SELECT count(*)::int FROM sog_lead_captures WHERE created_at >= $1 AND created_at < $2),
 'pendingDeliveries',(SELECT count(*)::int FROM sog_outbox WHERE type='lead' AND status='pending'),
 'failedDeliveries',(SELECT count(*)::int FROM sog_outbox WHERE type='lead' AND status='failed'),
 'reviewCycles',(SELECT count(*)::int FROM sog_lead_cycles WHERE status='review')
) AS report`;
const LEAD_SIGNAL_SQL=`SELECT jsonb_build_object(
 'pending',count(*) FILTER(WHERE status='pending')::int,
 'failed',count(*) FILTER(WHERE status='failed')::int
) AS report FROM sog_lead_capture_signals`;
const TASK_SQL=`SELECT jsonb_build_object(
 'pending',count(*) FILTER(WHERE status='pending')::int,
 'review',count(*) FILTER(WHERE status='review')::int
) AS report FROM sog_sales_tasks`;
async function routingReport(runQuery,range,flags=process.env){
 const [leads,tasks,leadSignals]=await Promise.all([
  (flags.LEAD_INTAKE_ENABLED==='true'||flags.GHL_LEAD_SIGNALS_ENABLED==='true')?runQuery(LEAD_SQL,range).then(({rows})=>({enabled:true,...rows[0].report})):Promise.resolve({enabled:false}),
  flags.GHL_TASKS_ENABLED==='true'?runQuery(TASK_SQL).then(({rows})=>({enabled:true,...rows[0].report})):Promise.resolve({enabled:false}),
  flags.GHL_LEAD_SIGNALS_ENABLED==='true'?runQuery(LEAD_SIGNAL_SQL).then(({rows})=>({enabled:true,...rows[0].report})):Promise.resolve({enabled:false})
 ]);
 return {leads,tasks,leadSignals};
}
module.exports = async (req,res) => {
 auth.headers(res);
 if(req.method!=='GET') return res.status(405).json({error:'method_not_allowed'});
 if(!auth.configured()) return res.status(503).json({error:'dashboard_not_configured'});
 if(!auth.authenticated(req)) return res.status(401).json({error:'unauthorized'});
 const days=Number(req.query?.days || 30);
 if(![7,30,90].includes(days)) return res.status(400).json({error:'invalid_window'});
 const end=new Date();const start=new Date(end.getTime()-days*86400000);
 try { const range=[start.toISOString(),end.toISOString()];
  const [{rows},routing,acquisition]=await Promise.all([query(SQL,range),routingReport(query,range),acquisitionReport(query,range)]);
  return res.status(200).json({...rows[0].report,routing,...acquisition,generatedAt:new Date().toISOString(),window:{start:start.toISOString(),end:end.toISOString(),timezone:'UTC'},definitions:{cohort:'One canonical contact per earliest recorded lead capture, accepted quiz or verified booking. Window selects first entry date across all time; progression is observed through report generation. First-touch attribution frozen on that entry groups source/medium/campaign. Lead-capture history is omitted and explicitly marked partial when its feature is disabled.',qualified:'Operational sales handoff: an accepted Apprentice quiz application OR a verified booking without a quiz. No fit score or policy qualification is inferred.',cohortWins:'Unique acquired contacts with a currently won cycle containing a verified booking. Total won also includes contacts whose won cycle has no verified booking. Both are current observed outcomes of the acquisition cohort, not revenue or period win-event totals.',setterCredit:'Period first-verified appointment bookings grouped only by appointment booking_setter_id. Administrator attestation is labeled; absent credit stays unknown, other recorded credit has unverified provenance. Won people must have a won cycle linked to that appointment. Contacts may occur in different setter rows; never sum contacts across setters.',bookings:'Distinct appointment IDs, counted once on first verified new/confirmed event, including those later cancelled. Not booking page visits.',applications:'Distinct accepted submission IDs; repeat applications by the same person are separate submissions.',attribution:'Latest known acquisition touch frozen at submission/appointment ingestion.',campaigns:'Source, medium, campaign and content from the same frozen latest acquisition touch; missing campaign/content shown as (not set).',outcomes:'Current appointment statuses for the same first-booked window cohort: new/confirmed active, cancelled/invalid cancelled, showed attended, noshow missed. Reschedules do not create additional bookings.',health:'Current totals across all dates.',leads:'Distinct lead contacts and accepted lead capture submissions within the selected window. Repeated captures count as separate submissions. These are separate from quiz applications; a person can appear in both.',routing:'Lead cycles requiring routing review, lead CRM delivery, native lead signal and managed-task queue/review totals are current across all dates. Lead deliveries are a subset of overall CRM deliveries. Lead routing reviews remain visible even when their delivery job succeeded. Disabled features have no reported counts, not zero counts.'}});
 } catch { return res.status(503).json({error:'reporting_unavailable'}); }
};

module.exports.SQL=SQL;

module.exports.routingReport=routingReport;
module.exports.LEAD_SQL=LEAD_SQL;
module.exports.TASK_SQL=TASK_SQL;

module.exports.LEAD_SIGNAL_SQL=LEAD_SIGNAL_SQL;

module.exports.funnelSQL=funnelSQL;
module.exports.setterSQL=setterSQL;
module.exports.acquisitionReport=acquisitionReport;
