const {event} = require('../lib/attribution');
const {saveEvent} = require('../lib/attribution-db');
const {body,publicRequest,fail} = require('../lib/attribution-http');
module.exports = async (req,res) => { try { await publicRequest(req,res,'event'); return res.status(202).json({ok:true,...await saveEvent(event(body(req)))}); } catch(error) {return fail(res,error);} };
