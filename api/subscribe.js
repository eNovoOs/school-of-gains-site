// POST /api/subscribe { email, source }
// Step 1 of the /join flow. Fans the email out to:
//   • Beehiiv — newsletter list + "Welcome to the floor" automation
//       BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID (pub_…)
//   • GoHighLevel — inbound webhook, stage "email_captured"
//       GHL_WEBHOOK_URL
// Each destination is independent; one failing never blocks the other.
const { sendToGHL, leadPayload, cleanAttribution } = require('../lib/ghl');
const {body:parseBody,publicRequest,fail}=require('../lib/attribution-http');
const {assertPilotContact}=require('../lib/intake-pilot');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });

  // New routing takes ownership of CRM delivery only after explicit activation.
  // No legacy CRM webhook is sent alongside it, avoiding competing deal creation.
  if(process.env.LEAD_INTAKE_ENABLED==='true') {
    try {
      await publicRequest(req,res,'lead');
      const raw=parseBody(req);
      const {lead,saveLead}=require('../lib/lead-intake');
      const input=lead({...raw,contact:{email},offer:'free_lessons'});
      assertPilotContact(input.contact.email);
      const result=await saveLead(input);
      const beehiiv=input.consent.marketing && !result.duplicate ? await subscribeBeehiiv(email,'join-flow',cleanAttribution(input.attribution.firstTouch)) : {ok:true,skipped:true};
      return res.status(result.duplicate?200:201).json({ok:true,...result,crmSync:'queued',beehiiv});
    }catch(error){return fail(res,error);}
  }
  const source = String((body && body.source) || 'join');
  const attr = cleanAttribution(body && body.attribution);
  const [beehiiv, ghl] = await Promise.all([
    body?.consent?.marketing===false ? Promise.resolve({ok:true,skipped:true}) : subscribeBeehiiv(email, source, attr),
    sendToGHL(leadPayload(req, email, 'email_captured', { form_source: source }, attr))
  ]);
  return res.status(200).json({ ok: beehiiv.ok || ghl.ok, beehiiv, ghl });
};

async function subscribeBeehiiv(email, source, attr) {
  const key = process.env.BEEHIIV_API_KEY;
  const pub = process.env.BEEHIIV_PUBLICATION_ID;
  if (!key || !pub) {
    console.warn('subscribe: newsletter integration not configured');
    return { ok: false, error: 'not_configured' };
  }
  try {
    const r = await fetch(`https://api.beehiiv.com/v2/publications/${pub}/subscriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        reactivate_existing: true,
        send_welcome_email: true,
        // Real campaign UTMs when the visitor arrived with them; otherwise tag the flow itself.
        utm_source: attr.utm_source || 'school-of-gains.com',
        utm_medium: attr.utm_medium || 'join-flow',
        utm_campaign: attr.utm_campaign || source,
        referring_site: attr.landing_page || undefined
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('subscribe: beehiiv error', r.status, data);
      return { ok: false, error: 'beehiiv_error' };
    }
    return { ok: true, status: data && data.data && data.data.status };
  } catch (e) {
    console.error('subscribe: exception', e);
    return { ok: false, error: 'exception' };
  }
}
