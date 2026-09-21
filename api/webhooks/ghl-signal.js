const {InputError}=require('../../lib/attribution');
const {body,authorize,fail}=require('../../lib/attribution-http');
const {signal,enqueue}=require('../../lib/ghl-signal');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(req.method!=='POST')throw new InputError('method_not_allowed',405);
  authorize(req,'GHL_EVENTS_SECRET');
  if(process.env.GHL_SIGNALS_ENABLED!=='true')throw new InputError('signals_disabled',503);
  return res.status(202).json({ok:true,...await enqueue(signal(body(req)))});
 }catch(error){return fail(res,error);}
};
