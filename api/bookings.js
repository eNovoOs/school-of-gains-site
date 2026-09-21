const {contextFor,bookingInput,book}=require('../lib/attribution-booking');
const {body,publicRequest,fail}=require('../lib/attribution-http');
module.exports=async(req,res)=>{
  try{
    await publicRequest(req,res,'booking');
    const payload=body(req),context=await contextFor(payload.ref),input=bookingInput(payload);
    const result=await book(context,input);
    return res.status(result.pending?202:200).json(result);
  }catch(error){return fail(res,error);}
};
