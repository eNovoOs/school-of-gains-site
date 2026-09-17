// POST /api/joined { email }
// Fired by the thank-you page when Whop sends the user back after "Join"
// (?via=join&status=success). Forwards stage "whop_joined" to the GHL inbound
// webhook so the CRM can tell completed sign-ups from abandoned ones.
const { sendToGHL, leadPayload } = require('../lib/ghl');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });

  const ghl = await sendToGHL(leadPayload(req, email, 'whop_joined', { whop_status: String((body && body.status) || '') }));
  return res.status(200).json(ghl);
};
