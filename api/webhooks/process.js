const {transaction} = require('../../lib/attribution-db');
const {syncApplication,syncAppointment} = require('../../lib/attribution-ghl');
const {InputError} = require('../../lib/attribution');
const {authorize,fail} = require('../../lib/attribution-http');
module.exports = async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  try {
    if(!['POST','GET'].includes(req.method)) throw new InputError('method_not_allowed',405);
    authorize(req,'CRON_SECRET');
    if(process.env.GHL_SYNC_ENABLED!=='true') throw new InputError('ghl_sync_disabled',503);
    const result=await transaction(async c=>{
      const {rows:[job]}=await c.query("SELECT * FROM sog_outbox WHERE status='pending' AND available_at<=now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
      if(!job) return {processed:0};
      try {
        if(job.type==='application') await syncApplication(c,job.payload);
        else if(job.type==='appointment') await syncAppointment(c,job.payload);
        else throw new Error('ghl_unsupported_job');
        await c.query("UPDATE sog_outbox SET status='delivered',attempts=attempts+1,last_error=NULL WHERE id=$1",[job.id]);
        return {processed:1};
      } catch(error) {
        const code=/^ghl_[a-z0-9_]+$/.test(error.message)?error.message:'ghl_delivery_failed';
        await c.query("UPDATE sog_outbox SET attempts=attempts+1,status=CASE WHEN attempts>=9 THEN 'failed' ELSE 'pending' END,last_error=$2,available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,attempts))::int) WHERE id=$1",[job.id,code]);
        return {processed:0,retryQueued:true};
      }
    });
    return res.status(200).json({ok:true,...result});
  } catch(error){return fail(res,error);}
};
