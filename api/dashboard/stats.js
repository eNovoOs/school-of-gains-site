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
 COALESCE(NULLIF(attribution->'latestTouch'->>'medium',''),NULLIF(attribution->'latestTouch'->>'utm_medium',''),'unknown') AS medium
 FROM sog_applications WHERE created_at >= $1 AND created_at < $2
), bookings AS (
 SELECT COALESCE(NULLIF(a.attribution->'latestTouch'->>'source',''),NULLIF(a.attribution->'latestTouch'->>'utm_source',''),'unknown') AS source,
 COALESCE(NULLIF(a.attribution->'latestTouch'->>'medium',''),NULLIF(a.attribution->'latestTouch'->>'utm_medium',''),'unknown') AS medium
 FROM booking_events e JOIN sog_appointments a ON a.id=e.appointment_id
 WHERE e.first_booked_at >= $1 AND e.first_booked_at < $2
), channel_counts AS (
 SELECT source,medium,count(*) AS applications,0::bigint AS bookings FROM applications GROUP BY source,medium
 UNION ALL
 SELECT source,medium,0::bigint,count(*) FROM bookings GROUP BY source,medium
), channels AS (
 SELECT source,medium,sum(applications)::int AS applications,sum(bookings)::int AS bookings FROM channel_counts GROUP BY source,medium
)
SELECT jsonb_build_object(
 'summary',jsonb_build_object(
 'visits',(SELECT count(DISTINCT journey_id)::int FROM sog_events WHERE type='page_view' AND occurred_at >= $1 AND occurred_at < $2),
 'applications',(SELECT count(*)::int FROM applications),
 'bookings',(SELECT count(*)::int FROM bookings),
 'attributedApplications',(SELECT count(*)::int FROM applications WHERE source NOT IN ('unknown','direct','(direct)'))),
 'channels',COALESCE((SELECT jsonb_agg(to_jsonb(channels) ORDER BY applications DESC,bookings DESC,source,medium) FROM channels),'[]'::jsonb),
 'health',jsonb_build_object(
 'openCycles',(SELECT count(*)::int FROM sog_sales_cycles WHERE status='open'),
 'unbookedCycles',(SELECT count(*)::int FROM sog_sales_cycles WHERE status='open' AND stage='unbooked'),
 'pendingDeliveries',(SELECT count(*)::int FROM sog_outbox WHERE status='pending'),
 'failedDeliveries',(SELECT count(*)::int FROM sog_outbox WHERE status='failed'),
 'pendingSignals',(SELECT count(*)::int FROM sog_provider_signals WHERE status='pending'),
 'failedSignals',(SELECT count(*)::int FROM sog_provider_signals WHERE status='failed'),
 'lastBookingEvent',(SELECT max(received_at) FROM sog_events WHERE type IN ('appointment_new','appointment_confirmed')))
) AS report`;
module.exports = async (req,res) => {
 auth.headers(res);
 if(req.method!=='GET') return res.status(405).json({error:'method_not_allowed'});
 if(!auth.configured()) return res.status(503).json({error:'dashboard_not_configured'});
 if(!auth.authenticated(req)) return res.status(401).json({error:'unauthorized'});
 const days=Number(req.query?.days || 30);
 if(![7,30,90].includes(days)) return res.status(400).json({error:'invalid_window'});
 const end=new Date();const start=new Date(end.getTime()-days*86400000);
 try { const {rows}=await query(SQL,[start.toISOString(),end.toISOString()]);
  return res.status(200).json({...rows[0].report,generatedAt:new Date().toISOString(),window:{start:start.toISOString(),end:end.toISOString(),timezone:'UTC'},definitions:{bookings:'Distinct appointment IDs, counted once on first verified new/confirmed event, including those later cancelled. Not booking page visits.',applications:'Distinct accepted submission IDs; repeat applications by the same person are separate submissions.',attribution:'Latest known acquisition touch frozen at submission/appointment ingestion.',health:'Current totals across all dates.'}});
 } catch { return res.status(503).json({error:'reporting_unavailable'}); }
};
