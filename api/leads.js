const {InputError}=require('../lib/attribution');
const {lead,saveLead}=require('../lib/lead-intake');
const {assertPilotContact}=require('../lib/intake-pilot');
const {body,publicRequest,fail}=require('../lib/attribution-http');
module.exports=async(req,res)=>{
 try {
  if(process.env.LEAD_INTAKE_ENABLED!=='true')throw new InputError('lead_intake_unavailable',503);
  await publicRequest(req,res,'lead');
  const input=lead(body(req));
  assertPilotContact(input.contact.email);
  const result=await saveLead(input);
  return res.status(result.duplicate?200:201).json({ok:true,...result,crmSync:'queued'});
 }catch(error){return fail(res,error);}
};
