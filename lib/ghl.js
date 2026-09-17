// Forward a lead event to a GoHighLevel Inbound Webhook (Automations → Workflow →
// trigger "Inbound Webhook"). Configured via GHL_WEBHOOK_URL; a no-op when unset.
// GHL maps the JSON keys to contact fields / custom values in the workflow.
async function sendToGHL(payload) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) {
    console.warn('ghl: GHL_WEBHOOK_URL not set — event not forwarded', payload.stage, payload.email);
    return { ok: false, error: 'not_configured' };
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      console.error('ghl: webhook error', r.status, await r.text().catch(() => ''));
      return { ok: false, error: 'ghl_error' };
    }
    return { ok: true };
  } catch (e) {
    console.error('ghl: exception', e);
    return { ok: false, error: 'exception' };
  }
}

function leadPayload(req, email, stage, extra) {
  const h = req.headers || {};
  return Object.assign(
    {
      email,
      stage,                                  // email_captured | whop_joined
      source: 'school-of-gains.com',
      funnel: 'discord-join-flow',
      tags: ['discord-join-flow', stage],
      timestamp: new Date().toISOString(),
      ip: (h['x-forwarded-for'] || '').split(',')[0].trim() || undefined,
      user_agent: h['user-agent'],
      referer: h['referer']
    },
    extra || {}
  );
}

module.exports = { sendToGHL, leadPayload };
