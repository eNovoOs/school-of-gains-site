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
  const [{rows},routing]=await Promise.all([query(SQL,range),routingReport(query,range)]);
  return res.status(200).json({...rows[0].report,routing,generatedAt:new Date().toISOString(),window:{start:start.toISOString(),end:end.toISOString(),timezone:'UTC'},definitions:{bookings:'Distinct appointment IDs, counted once on first verified new/confirmed event, including those later cancelled. Not booking page visits.',applications:'Distinct accepted submission IDs; repeat applications by the same person are separate submissions.',attribution:'Latest known acquisition touch frozen at submission/appointment ingestion.',campaigns:'Source, medium, campaign and content from the same frozen latest acquisition touch; missing campaign/content shown as (not set).',outcomes:'Current appointment statuses for the same first-booked window cohort: new/confirmed active, cancelled/invalid cancelled, showed attended, noshow missed. Reschedules do not create additional bookings.',health:'Current totals across all dates.',leads:'Distinct lead contacts and accepted lead capture submissions within the selected window. Repeated captures count as separate submissions. These are separate from quiz applications; a person can appear in both.',routing:'Lead cycles requiring routing review, lead CRM delivery, native lead signal and managed-task queue/review totals are current across all dates. Lead deliveries are a subset of overall CRM deliveries. Lead routing reviews remain visible even when their delivery job succeeded. Disabled features have no reported counts, not zero counts.'}});
 } catch { return res.status(503).json({error:'reporting_unavailable'}); }
};

module.exports.SQL=SQL;

module.exports.routingReport=routingReport;
module.exports.LEAD_SQL=LEAD_SQL;
module.exports.TASK_SQL=TASK_SQL;

module.exports.LEAD_SIGNAL_SQL=LEAD_SIGNAL_SQL;
