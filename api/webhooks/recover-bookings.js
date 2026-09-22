const {InputError}=require('../../lib/attribution');
const {authorize,fail}=require('../../lib/attribution-http');
const {processOne}=require('../../lib/booking-recovery');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(!['GET','POST'].includes(req.method))throw new InputError('method_not_allowed',405);
  authorize(req,'CRON_SECRET');
  if(process.env.GHL_BOOKING_RECOVERY_ENABLED!=='true' || process.env.GHL_SYNC_ENABLED!=='true')throw new InputError('booking_recovery_disabled',503);
  // One job: at most five 12-second provider reads plus bounded DB persistence.
  return res.status(200).json({ok:true,...await processOne()});
 }catch(error){return fail(res,error);}
};
