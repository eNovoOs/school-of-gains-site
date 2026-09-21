const auth = require('../../lib/dashboard-auth');
const { createHash } = require('node:crypto');
const { rateLimit } = require('../../lib/attribution-db');
module.exports = async (req,res) => {
  auth.headers(res);
  if (!auth.configured()) return res.status(503).json({error:'dashboard_not_configured'});
  if (req.method === 'GET') return res.status(auth.authenticated(req) ? 200 : 401).json({authenticated:auth.authenticated(req)});
  if (!['POST','DELETE'].includes(req.method)) return res.status(405).json({error:'method_not_allowed'});
  if (!auth.sameOrigin(req)) return res.status(403).json({error:'origin_not_allowed'});
  if (req.method === 'DELETE') { auth.clearSession(res); return res.status(200).json({authenticated:false}); }
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  try { await rateLimit('dashboard-login:' + createHash('sha256').update(ip).digest('hex'),10); }
  catch(error) { return res.status(error.status === 429 ? 429 : 503).json({error:error.status === 429 ? 'rate_limited' : 'authentication_unavailable'}); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body.key !== 'string' || body.key.length > 512 || !auth.equal(body.key,process.env.DASHBOARD_ACCESS_KEY)) return res.status(401).json({error:'invalid_credentials'});
  auth.setSession(res);
  return res.status(200).json({authenticated:true});
};
