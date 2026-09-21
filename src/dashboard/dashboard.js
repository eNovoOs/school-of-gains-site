(() => {
  const $ = id => document.getElementById(id);
  const fmt = n => Number(n || 0).toLocaleString();
  function node(tag,text) { const el = document.createElement(tag); el.textContent = text; return el; }
  function loggedIn(value) { $('login').hidden=value; $('report').hidden=!value; $('logout').hidden=!value; }
  async function request(path,options={}) { const r = await fetch('/api/dashboard/'+path,{credentials:'same-origin',...options}); const data=await r.json().catch(()=>({})); if(!r.ok) { const error=new Error(data.error || 'request_failed'); error.status=r.status; throw error; } return data; }
  function row(parent,label,value) { const el=node('div','');el.className='row';el.append(node('span',label),node('b',value));parent.append(el); }
  async function refresh() {
    $('status').textContent='Loading recorded activity…';
    $('metrics').replaceChildren();$('channels').replaceChildren();$('health').replaceChildren();$('pipeline').replaceChildren();
    try { const data=await request('stats?days='+$('days').value);
      const metrics=[['Tracked visits',data.summary.visits,'Distinct journeys with a recorded page view.'],['Applications',data.summary.applications,'Distinct submitted applications.'],['Confirmed bookings',data.summary.bookings,'Distinct appointment IDs with a verified booking event.'],['Attributed applications',data.summary.attributedApplications,'Applications carrying a known acquisition source.']];
      for(const [label,value,hint] of metrics) { const el=node('article','');el.className='metric';el.append(node('span',label),node('b',fmt(value)),node('small',hint));$('metrics').append(el); }
      for(const channel of data.channels) { const tr=node('tr','');for(const value of [channel.source,channel.medium,fmt(channel.applications),fmt(channel.bookings)]) tr.append(node('td',value));$('channels').append(tr); }
      if(!data.channels.length) { const tr=node('tr','');const td=node('td','No applications or confirmed bookings recorded in this window.');td.colSpan=4;tr.append(td);$('channels').append(tr); }
      row($('pipeline'),'Open sales cycles',fmt(data.health.openCycles));
      row($('pipeline'),'Currently unbooked',fmt(data.health.unbookedCycles));
      row($('health'),'Pending CRM deliveries',fmt(data.health.pendingDeliveries));
      row($('health'),'Failed CRM deliveries',fmt(data.health.failedDeliveries));
      row($('health'),'Pending provider signals',fmt(data.health.pendingSignals));
      row($('health'),'Signals requiring review',fmt(data.health.failedSignals));
      row($('health'),'Applications without source',fmt(data.summary.applications-data.summary.attributedApplications));
      row($('health'),'Last verified booking event',data.health.lastBookingEvent ? new Date(data.health.lastBookingEvent).toLocaleString() : 'None recorded');
      $('status').textContent='Updated '+new Date(data.generatedAt).toLocaleString()+'. Window: '+data.window.start.slice(0,10)+' to '+data.window.end.slice(0,10)+' UTC.';
    } catch(error) { if(error.status===401) loggedIn(false); $('status').textContent='Reporting unavailable. No metrics have been substituted. Check the database and tracking configuration.'; }
  }
  $('login-form').addEventListener('submit',async e=>{e.preventDefault();const btn=e.target.querySelector('button');btn.disabled=true;try { await request('session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('key').value})});$('key').value='';$('login-status').textContent='';loggedIn(true);await refresh(); } catch(error) { $('login-status').textContent=error.status===503?'Dashboard access has not been configured.':'Sign-in failed. Check your access key.'; } finally { btn.disabled=false; } });
  $('logout').addEventListener('click',async()=>{try{await request('session',{method:'DELETE'});loggedIn(false);$('metrics').replaceChildren();$('channels').replaceChildren();}catch{$('status').textContent='Sign-out failed. Please retry.';}});
  $('filters').addEventListener('submit',e=>{e.preventDefault();refresh();});
  request('session').then(()=>{loggedIn(true);refresh();}).catch(error=>{loggedIn(false);if(error.status===503)$('login-status').textContent='Dashboard access has not been configured.';});
})();
