const {InputError}=require('../lib/attribution');
const {contextFor,config}=require('../lib/attribution-booking');
const {fail}=require('../lib/attribution-http');
const {query}=require('../lib/attribution-db');
module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  try{
    if(req.method!=='GET')throw new InputError('method_not_allowed',405);
    const context=await contextFor(req.query?.ref);
    const needsReview=context.cycle_status!=='open' || !context.ghl_opportunity_id || ['legacy_review','customer_review'].includes(context.cycle_stage);
    const configured=config().enabled;
    const crmPending=configured && context.crm_status==='pending' && context.cycle_status==='open' && !['legacy_review','customer_review'].includes(context.cycle_stage);
    const enabled=configured && !!context.ghl_contact_id && context.crm_status==='delivered' && !needsReview;
    const {rows:[intent]}=await query("SELECT i.*,a.starts_at AS appointment_start,a.status AS appointment_status FROM sog_booking_intents i LEFT JOIN sog_appointments a ON a.id=i.appointment_id WHERE i.cycle_id=$1 AND i.state IN ('pending','uncertain','confirmed','cancelled') ORDER BY i.created_at DESC LIMIT 1",[context.cycle_id]);
    const canonical=intent?.appointment_status;
    const resolved=canonical && ['new','confirmed'].includes(canonical)?'confirmed':canonical || intent?.state;
    const retryable=intent && !canonical && ['pending','uncertain'].includes(intent.state);
    const existingBooking=intent?{bookingId:intent.id,startTime:new Date(canonical?intent.appointment_start:intent.start_time).toISOString(),originalStartTime:new Date(intent.start_time).toISOString(),timezone:intent.timezone,state:resolved,canRetry:!!retryable && intent.application_id===context.id}:null;
    return res.status(200).json({ok:true,applicationId:context.id,bookingEnabled:enabled,crmPending,existingBooking,reason:enabled?null:crmPending?'contact_sync_pending':needsReview?'sales_review_required':context.ghl_contact_id?'calendar_integration_pending':'contact_sync_pending',crmSync:context.crm_status==='delivered'?'linked':'queued'});
  }catch(error){return fail(res,error);}
};
