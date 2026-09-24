// POST /api/joined { email }
// Fired by the thank-you page when Whop sends the user back after "Join"
// (?via=join&status=success). A browser return is not verified membership.
// New routing leaves fulfillment to the existing provider-side Whop handler.
const { sendToGHL, leadPayload } = require('../lib/ghl');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });

  if (process.env.LEAD_INTAKE_ENABLED === 'true') {
    // Do not let a forged/replayed return URL create a competing deal, affiliate
    // tag or entitlement. The lead was already captured before Whop checkout.
    return res.status(200).json({ ok: true, membershipVerified: false, crmSync: 'unchanged' });
  }

  const ghl = await sendToGHL(leadPayload(req, email, 'whop_joined', { whop_status: String((body && body.status) || '') }, body && body.attribution));
  return res.status(200).json(ghl);
};
