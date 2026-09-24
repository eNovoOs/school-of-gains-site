const {createHmac}=require('node:crypto');
const auth=require('../../lib/dashboard-auth');
const {body,fail}=require('../../lib/attribution-http');
const {InputError}=require('../../lib/attribution');
const {rateLimit}=require('../../lib/attribution-db');
const {setterRoster,attest}=require('../../lib/setter-credit');
module.exports=async(req,res)=>{
 auth.headers(res);
 try{
  if(!['GET','POST'].includes(req.method))throw new InputError('method_not_allowed',405);
  if(!auth.configured())throw new InputError('dashboard_not_configured',503);
  if(!auth.authenticated(req))throw new InputError('unauthorized',401);
  if(process.env.SETTER_CREDIT_ENABLED!=='true')throw new InputError('setter_credit_disabled',503);
  if(req.method==='GET')return res.status(200).json({enabled:true,setters:setterRoster(),evidenceType:'admin_attested'});
  if(!auth.sameOrigin(req))throw new InputError('origin_not_allowed',403);
  if(!String(req.headers['content-type']||'').includes('application/json'))throw new InputError('json_required',415);
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-sog_dashboard='));
  const sessionHash=createHmac('sha256',process.env.DASHBOARD_SESSION_SECRET).update(cookie).digest('hex');
  await rateLimit('setter-credit:'+sessionHash,10);
  return res.status(200).json(await attest(body(req),sessionHash));
 }catch(error){return fail(res,error);}
};
