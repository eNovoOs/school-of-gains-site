const {InputError}=require('../lib/attribution');
const {contextFor,config}=require('../lib/attribution-booking');
const {fail}=require('../lib/attribution-http');
const {query}=require('../lib/attribution-db');
module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  try{
    if(req.method!=='GET')throw new InputError('method_not_allowed',405);
    const context=await contextFor(req.query?.ref);
    const enabled=config().enabled && !!context.ghl_contact_id && context.crm_status==='delivered';
    const {rows:[intent]}=await query("SELECT * FROM sog_booking_intents WHERE cycle_id=$1 AND state IN ('pending','uncertain','confirmed') ORDER BY created_at DESC LIMIT 1",[context.cycle_id]);
    const existingBooking=intent?{bookingId:intent.id,startTime:new Date(intent.start_time).toISOString(),timezone:intent.timezone,state:intent.state,canRetry:intent.application_id===context.id}:null;
    return res.status(200).json({ok:true,applicationId:context.id,bookingEnabled:enabled,existingBooking,reason:enabled?null:context.ghl_contact_id?'calendar_integration_pending':'contact_sync_pending',crmSync:context.crm_status==='delivered'?'linked':'queued'});
  }catch(error){return fail(res,error);}
};
