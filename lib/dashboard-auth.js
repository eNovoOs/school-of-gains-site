const crypto = require('node:crypto');
const COOKIE = '__Host-sog_dashboard';
const TTL = 8 * 60 * 60;
function configured() { return (process.env.DASHBOARD_ACCESS_KEY || '').length >= 32 && (process.env.DASHBOARD_SESSION_SECRET || '').length >= 32; }
function equal(a, b) { const hash = x => crypto.createHash('sha256').update(String(x || '')).digest(); return crypto.timingSafeEqual(hash(a), hash(b)); }
function sign(value) { return crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(value).digest('base64url'); }
function token() { const value = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + TTL, nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url'); return `${value}.${sign(value)}`; }
function authenticated(req) {
  if (!configured()) return false;
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  if (!raw) return false;
  const parts = raw.slice(COOKIE.length + 1).split('.');
  if (parts.length !== 2 || parts[0].length > 500 || !equal(parts[1], sign(parts[0]))) return false;
  try { const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); const now = Math.floor(Date.now()/1000); return Number.isInteger(data.exp) && data.exp > now && data.exp <= now + TTL; } catch { return false; }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = [process.env.APP_ORIGIN, process.env.SITE_ORIGIN, process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`].filter(Boolean);
  return allowed.some(x => { try { return new URL(x).origin === origin; } catch { return false; } });
}
function headers(res) { res.setHeader('Cache-Control','private, no-store'); res.setHeader('Vary','Cookie'); res.setHeader('X-Content-Type-Options','nosniff'); }
function setSession(res) { res.setHeader('Set-Cookie',`${COOKIE}=${token()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL}`); }
function clearSession(res) { res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`); }
module.exports = { configured, equal, authenticated, sameOrigin, headers, setSession, clearSession };
