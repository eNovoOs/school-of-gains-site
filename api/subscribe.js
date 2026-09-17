// POST /api/subscribe { email, source }
// Adds the email to the School of Gains Beehiiv list (same publication as the
// site's embedded forms) so the /join flow keeps feeding the newsletter and the
// "Welcome to the floor" automation. Requires env vars:
//   BEEHIIV_API_KEY         — Beehiiv API key (Settings → API)
//   BEEHIIV_PUBLICATION_ID  — e.g. pub_xxxxxxxx-xxxx-...
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });

  const key = process.env.BEEHIIV_API_KEY;
  const pub = process.env.BEEHIIV_PUBLICATION_ID;
  if (!key || !pub) {
    console.warn('subscribe: BEEHIIV_API_KEY / BEEHIIV_PUBLICATION_ID not set — email not stored', email);
    return res.status(200).json({ ok: false, error: 'not_configured' });
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
        utm_campaign: String((body && body.source) || 'join')
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('subscribe: beehiiv error', r.status, data);
      return res.status(502).json({ ok: false, error: 'beehiiv_error' });
    }
    return res.status(200).json({ ok: true, status: data && data.data && data.data.status });
  } catch (e) {
    console.error('subscribe: exception', e);
    return res.status(502).json({ ok: false, error: 'exception' });
  }
};
