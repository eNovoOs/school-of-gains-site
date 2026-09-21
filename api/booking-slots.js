const {InputError}=require('../lib/attribution');
const {contextFor,slots}=require('../lib/attribution-booking');
const {rateLimit}=require('../lib/attribution-db');
const {fail}=require('../lib/attribution-http');
module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  try{
    if(req.method!=='GET')throw new InputError('method_not_allowed',405);
    const context=await contextFor(req.query?.ref);
    await rateLimit('booking-slots:'+context.id,30);
    return res.status(200).json({ok:true,slots:await slots(context,req.query),timezone:req.query.timezone});
  }catch(error){return fail(res,error);}
};
