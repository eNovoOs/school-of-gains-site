const {InputError}=require('../../lib/attribution');
const {authorize,fail}=require('../../lib/attribution-http');
const {processOne}=require('../../lib/ghl-signal');
const {runBatch}=require('../../lib/worker-batch');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(!['GET','POST'].includes(req.method))throw new InputError('method_not_allowed',405);
  authorize(req,'CRON_SECRET');
  if(process.env.GHL_SIGNALS_ENABLED!=='true' || process.env.GHL_SYNC_ENABLED!=='true')throw new InputError('signals_disabled',503);
  return res.status(200).json({ok:true,...await runBatch(()=>processOne())});
 }catch(error){return fail(res,error);}
};
