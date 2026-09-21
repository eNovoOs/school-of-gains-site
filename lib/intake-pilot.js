const {InputError}=require('./attribution');
function assertPilotContact(email,env=process.env) {
  if(!env.ATTRIBUTION_PILOT_EMAILS)return;
  const allowed=env.ATTRIBUTION_PILOT_EMAILS.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(!allowed.length || allowed.some(x=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))throw new InputError('pilot_configuration_invalid',503);
  if(!allowed.includes(email.trim().toLowerCase()))throw new InputError('intake_unavailable',503);
}
module.exports={assertPilotContact};
