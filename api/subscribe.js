// POST /api/subscribe { email, source }
// Step 1 of the /join flow. Fans the email out to:
//   • Beehiiv — newsletter list + "Welcome to the floor" automation
//       BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID (pub_…)
//   • GoHighLevel — inbound webhook, stage "email_captured"
//       GHL_WEBHOOK_URL
// Each destination is independent; one failing never blocks the other.
const { sendToGHL, leadPayload } = require('../lib/ghl');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });

  const source = String((body && body.source) || 'join');
  const [beehiiv, ghl] = await Promise.all([
    subscribeBeehiiv(email, source),
    sendToGHL(leadPayload(req, email, 'email_captured', { form_source: source }))
  ]);
  return res.status(200).json({ ok: beehiiv.ok || ghl.ok, beehiiv, ghl });
};

async function subscribeBeehiiv(email, source) {
  const key = process.env.BEEHIIV_API_KEY;
  const pub = process.env.BEEHIIV_PUBLICATION_ID;
  if (!key || !pub) {
    console.warn('subscribe: BEEHIIV_API_KEY / BEEHIIV_PUBLICATION_ID not set — email not stored', email);
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
        utm_source: 'school-of-gains.com',
        utm_medium: 'join-flow',
        utm_campaign: source
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
