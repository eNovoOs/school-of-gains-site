const {application} = require('../lib/attribution');
const {saveApplication} = require('../lib/attribution-db');
const {body,publicRequest,fail,bookingPath} = require('../lib/attribution-http');
module.exports = async (req,res) => {
  try {
    await publicRequest(req,res,'application');
    const result = await saveApplication(application(body(req)));
    return res.status(result.duplicate?200:201).json({ok:true,...result,bookingPath:bookingPath(result.applicationId),crmSync:'queued'});
  } catch(error) { return fail(res,error); }
};
