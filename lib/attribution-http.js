const { createHash, createHmac } = require('node:crypto');
const {InputError,secureEqual} = require('./attribution');
const {rateLimit} = require('./attribution-db');
function body(req) {
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  if (Buffer.byteLength(raw) > 24000) throw new InputError('body_too_large',413);
  try { return JSON.parse(raw); } catch { throw new InputError('invalid_json'); }
}
async function publicRequest(req,res,kind) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') throw new InputError('method_not_allowed',405);
  if (kind === 'application' && (!process.env.HANDOFF_SECRET || process.env.HANDOFF_SECRET.length < 32)) throw new InputError('intake_unavailable',503);
  if (process.env.ATTRIBUTION_INTAKE_ENABLED !== 'true') throw new InputError('intake_unavailable',503);
  const origin = req.headers.origin;
  const allowed = (process.env.ATTRIBUTION_ALLOWED_ORIGINS || process.env.APP_ORIGIN || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) throw new InputError('origin_not_allowed',403);
  if (!String(req.headers['content-type'] || '').includes('application/json')) throw new InputError('json_required',415);
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0];
  const key = createHash('sha256').update(kind+':'+ip).digest('hex');
  await rateLimit(key,['application','booking','lead'].includes(kind) ? 8 : 90);
}
function authorize(req,secretName) { const secret = process.env[secretName]; if (!secret || secret.length < 32) throw new InputError('integration_unavailable',503); if (!secureEqual(req.headers.authorization,`Bearer ${secret}`)) throw new InputError('unauthorized',401); }
function fail(res,error) { const status = error instanceof InputError ? error.status : 503; return res.status(status).json({ok:false,error:error instanceof InputError ? error.message : 'temporarily_unavailable'}); }
function bookingPath(applicationId, expiresAt=Date.now()+3600000) {
  if (!process.env.HANDOFF_SECRET || process.env.HANDOFF_SECRET.length < 32) return '/book';
  if(!Number.isFinite(expiresAt) || expiresAt<=Date.now() || expiresAt>Date.now()+72*3600000)throw new InputError('invalid_handoff_expiry',400);
  const value = Buffer.from(JSON.stringify({id:applicationId,expires:expiresAt})).toString('base64url');
  return '/book?ref='+value+'.'+createHmac('sha256',process.env.HANDOFF_SECRET).update(value).digest('base64url');
}
module.exports = {body,publicRequest,authorize,fail,bookingPath};
