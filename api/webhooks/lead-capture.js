const {InputError}=require('../../lib/attribution');
const {body,authorize,fail}=require('../../lib/attribution-http');
const {signal,enqueue}=require('../../lib/lead-capture-signal');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(req.method!=='POST')throw new InputError('method_not_allowed',405);
  authorize(req,'GHL_EVENTS_SECRET');
  if(process.env.GHL_LEAD_SIGNALS_ENABLED!=='true')throw new InputError('lead_signals_unavailable',503);
  const input=signal(body(req));
  return res.status(202).json({ok:true,...await enqueue(input)});
 }catch(error){return fail(res,error);}
};
