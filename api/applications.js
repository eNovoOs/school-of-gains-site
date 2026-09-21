const {application} = require('../lib/attribution');
const {saveApplication} = require('../lib/attribution-db');
const {assertPilotContact} = require('../lib/intake-pilot');
const {body,publicRequest,fail,bookingPath} = require('../lib/attribution-http');
module.exports = async (req,res) => {
  try {
    await publicRequest(req,res,'application');
    const input=application(body(req));
    assertPilotContact(input.contact.email);
    const result = await saveApplication(input);
    return res.status(result.duplicate?200:201).json({ok:true,...result,bookingPath:bookingPath(result.applicationId),crmSync:'queued'});
  } catch(error) { return fail(res,error); }
};
