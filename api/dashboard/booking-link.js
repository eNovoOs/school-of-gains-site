const auth=require('../../lib/dashboard-auth');
const {body,fail}=require('../../lib/attribution-http');
const {InputError}=require('../../lib/attribution');
const {rateLimit}=require('../../lib/attribution-db');
const {reissue}=require('../../lib/booking-link-reissue');
const {createHash}=require('node:crypto');
module.exports=async(req,res)=>{
 auth.headers(res);res.setHeader('Referrer-Policy','no-referrer');
 try{
  if(req.method!=='POST')throw new InputError('method_not_allowed',405);
  if(!auth.authenticated(req))throw new InputError('unauthorized',401);
  if(!auth.sameOrigin(req))throw new InputError('origin_not_allowed',403);
  if(!String(req.headers['content-type'] || '').includes('application/json'))throw new InputError('json_required',415);
  const sessionHash=createHash('sha256').update(req.headers.cookie || '').digest('hex');
  await rateLimit('booking-link:'+sessionHash,10);
  return res.status(200).json(await reissue(body(req)));
 }catch(error){return fail(res,error);}
};
