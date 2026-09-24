(() => {
 const $=id=>document.getElementById(id);let pending=null;
 async function api(path,options={}) {
  const response=await fetch('/api/dashboard/'+path,{credentials:'same-origin',cache:'no-store',...options});
  const value=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(value.error || 'request_failed');error.status=response.status;throw error;}return value;
 }
 function authenticated(value){$('staff-login').hidden=value;$('reissue-form').hidden=!value;if(!value){$('reissue-result').hidden=true;$('booking-link').value='';}}
 function message(error){
  return ({application_not_found:'No application found for that email. Check the contact in GoHighLevel.',contact_sync_pending:'This application is still syncing. Try again shortly.',booking_unavailable:'Booking is not enabled in this environment yet.',sales_review_required:'This lead needs sales review before a new link can be issued.',appointment_already_exists:'This lead already has an active appointment. Manage it in GoHighLevel.',contact_identity_changed:'The contact details have changed. Review the contact in GoHighLevel.',rate_limited:'Too many requests. Please wait a minute.',reissue_expired:'This request has expired. Submit again to create a fresh link.'})[error.message] || 'Could not create a link. Please try again or review the contact in GoHighLevel.';
 }
 $('staff-login').addEventListener('submit',async event=>{event.preventDefault();try{await api('session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('staff-key').value})});$('staff-key').value='';authenticated(true);$('reissue-status').textContent='Enter the applicant email to continue.';}catch{ $('reissue-status').textContent='Unable to sign in. Check your dashboard access key.';}});
 $('reissue-form').addEventListener('submit',async event=>{
  event.preventDefault();const email=$('applicant-email').value.trim().toLowerCase();
  if(!pending || pending.email!==email)pending={email,requestId:crypto.randomUUID()};
  $('generate-link').disabled=true;$('reissue-result').hidden=true;$('booking-link').value='';$('reissue-status').textContent='Verifying the application and current sales status…';
  try{
   const result=await api('booking-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending)});
   const url=new URL(result.path,location.origin);
   if(url.origin!==location.origin || url.pathname!=='/book')throw new Error('invalid_link');
   $('booking-link').value=url.href;$('link-expiry').textContent='Expires '+new Date(result.expiresAt).toLocaleString()+'.';$('reissue-result').hidden=false;$('reissue-status').textContent='Link created. Copy it and share it with the applicant.';
  }catch(error){if(error.status===401){authenticated(false);$('reissue-status').textContent='Your session expired. Sign in again.';}else{$('reissue-status').textContent=message(error);if(error.message==='reissue_expired')pending=null;}}
  finally{$('generate-link').disabled=false;}
 });
 $('copy-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('booking-link').value);$('reissue-status').textContent='Booking link copied.';}catch{$('booking-link').select();$('reissue-status').textContent='Select and copy the link above.';}});
 api('session').then(()=>{authenticated(true);$('reissue-status').textContent='Enter the applicant email to continue.';}).catch(()=>{authenticated(false);$('reissue-status').textContent='Sign in with your dashboard access key.';});
})();
