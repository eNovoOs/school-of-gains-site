(()=>{
 const $=id=>document.getElementById(id);
 let requestId;
 async function api(options={}){const response=await fetch('/api/dashboard/setter-credit',{credentials:'same-origin',...options});const data=await response.json();if(!response.ok){const error=new Error(data.error||'request_failed');error.status=response.status;throw error;}return data;}
 function errorMessage(error){
  if(error.status===401){$('credit-login').hidden=false;return 'Sign in to the dashboard to record a reviewed attestation.';}
  const messages={setter_credit_disabled:'Setter credit capture has not been enabled.',setter_roster_invalid:'The verified setter roster needs configuration.',credit_already_recorded:'This appointment already has different setter credit. No changes were made. Request an audited correction.',credit_ledger_conflict:'Recorded attribution requires administrator review. No changes were made.',verified_booking_required:'This appointment has not yet been verified in the booking ledger. Check the appointment ID or wait for booking sync.',credit_contact_mismatch:'Provider contact identity could not be confirmed. No credit was recorded.',credit_request_conflict:'This request conflicts with an earlier attestation. Reload before trying again.',setter_not_allowed:'This setter is not in the approved roster.',rate_limited:'Too many attempts. Please wait a minute.'};
  return messages[error.message]||'The attestation could not be confirmed. Retry the same details; do not assume it was recorded.';
 }
 $('credit-form').addEventListener('input',()=>{requestId=undefined;});
 $('credit-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
  requestId ||= crypto.randomUUID();
  try{const result=await api({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,appointmentId:$('appointment').value.trim(),setterId:$('setter').value,reason:$('reason').value.trim()})});
   $('credit-status').textContent=result.duplicate?'This appointment already has the same recorded administrator-attested credit. No duplicate was created.':'Administrator-attested booking credit recorded. This is reviewed attribution, not individual staff authentication.';
  }catch(error){$('credit-status').textContent=errorMessage(error);}finally{button.disabled=false;}
 });
 api().then(data=>{for(const setter of data.setters){const option=document.createElement('option');option.value=setter.id;option.textContent=setter.name;$('setter').append(option);}$('credit-form').hidden=false;$('credit-status').textContent='Choose the setter only after reviewing evidence for the exact appointment.';}).catch(error=>{$('credit-status').textContent=errorMessage(error);});
})();
