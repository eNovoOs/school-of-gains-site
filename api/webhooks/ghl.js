// Receives the explicit v1 payload configured in the replacement GHL Custom Webhook.
// Native Marketplace payloads are NOT accepted by this adapter without transformation.
const {appointment,opportunity,InputError} = require('../../lib/attribution');
const {saveAppointment,saveOpportunity} = require('../../lib/attribution-db');
const {body,authorize,fail} = require('../../lib/attribution-http');
module.exports = async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  try {
    if(req.method!=='POST') throw new InputError('method_not_allowed',405);
    authorize(req,'GHL_EVENTS_SECRET');
    const payload=body(req);
    if(payload.type==='opportunity_updated') return res.status(200).json({ok:true,...await saveOpportunity(opportunity(payload))});
    const input = appointment(payload);
    const allowed = (process.env.GHL_CALENDAR_IDS || '').split(',').map(value=>value.trim()).filter(Boolean);
    if(!allowed.includes(input.calendarId)) throw new InputError('calendar_not_allowed',403);
    return res.status(200).json({ok:true,...await saveAppointment(input)});
  } catch(error) { return fail(res,error); }
};
