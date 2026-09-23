(() => {
  const $ = id => document.getElementById(id);
  const fmt = n => Number(n || 0).toLocaleString();
  function node(tag,text) { const el = document.createElement(tag); el.textContent = text; return el; }
  function loggedIn(value) { $('login').hidden=value; $('report').hidden=!value; $('logout').hidden=!value; }
  async function request(path,options={}) { const r = await fetch('/api/dashboard/'+path,{credentials:'same-origin',...options}); const data=await r.json().catch(()=>({})); if(!r.ok) { const error=new Error(data.error || 'request_failed'); error.status=r.status; throw error; } return data; }
  function row(parent,label,value) { const el=node('div','');el.className='row';el.append(node('span',label),node('b',value));parent.append(el); }
  function clearReport() { for (const id of ['metrics','channels','campaigns','outcomes','health','pipeline','leads']) $(id).replaceChildren(); }
  function emptyTable(parent, text, columns) { const tr=node('tr','');const td=node('td',text);td.colSpan=columns;tr.append(td);parent.append(tr); }
  function campaignReports(data) {
    if (!Array.isArray(data.campaigns)) emptyTable($('campaigns'),'Campaign reporting unavailable.',6);
    else if (!data.campaigns.length) emptyTable($('campaigns'),'No applications or confirmed bookings recorded in this window.',6);
    else for (const campaign of data.campaigns) {
      const tr=node('tr','');
      for (const value of [campaign.source,campaign.medium,campaign.campaign || '(not set)',campaign.content || '(not set)',fmt(campaign.applications),fmt(campaign.bookings)]) tr.append(node('td',value));
      $('campaigns').append(tr);
    }
    const categories=[['active','Active'],['cancelled','Cancelled'],['attended','Attended'],['missed','Missed'],['other','Other']];
    if (!data.outcomes || !categories.every(([key])=>Number.isFinite(data.outcomes[key]) && data.outcomes[key]>=0)) {
      $('outcomes').append(node('p','Booking outcomes unavailable.'));
    } else for (const [key,label] of categories) row($('outcomes'),label,fmt(data.outcomes[key]));
  }
  function routingReports(data) {
    const count=value=>Number.isInteger(value) && value>=0?fmt(value):'Unavailable';
    const leads=data.routing?.leads,tasks=data.routing?.tasks,signals=data.routing?.leadSignals;
    if(leads?.enabled===true){
      row($('leads'),'Distinct lead contacts',count(leads.distinctContacts));
      row($('leads'),'Lead capture submissions',count(leads.captures));
      row($('health'),'Pending lead CRM deliveries',count(leads.pendingDeliveries));
      row($('health'),'Failed lead CRM deliveries',count(leads.failedDeliveries));
      row($('health'),'Lead deals needing routing review',count(leads.reviewCycles));
    }else {
      $('leads').append(node('p',leads?.enabled===false?'Lead intake reporting is not enabled.':'Lead intake reporting unavailable.'));
      row($('health'),'Lead routing review reporting',leads?.enabled===false?'Not enabled':'Unavailable');
    }
    if(signals?.enabled===true){
      row($('health'),'Pending GHL lead signals',count(signals.pending));
      row($('health'),'Failed GHL lead signals',count(signals.failed));
    }else row($('health'),'GHL lead signal reporting',signals?.enabled===false?'Not enabled':'Unavailable');
    if(tasks?.enabled===true){
      row($('health'),'Managed tasks awaiting sync',count(tasks.pending));
      row($('health'),'Managed tasks needing review',count(tasks.review));
    }else row($('health'),'Managed task reporting',tasks?.enabled===false?'Not enabled':'Unavailable');
  }
  async function refresh() {
    $('status').textContent='Loading recorded activity…';
    clearReport();
    try { const data=await request('stats?days='+$('days').value);
      const metrics=[['Tracked visits',data.summary.visits,'Distinct journeys with a recorded page view.'],['Applications',data.summary.applications,'Distinct submitted applications.'],['Confirmed bookings',data.summary.bookings,'Distinct appointment IDs with a verified booking event.'],['Attributed applications',data.summary.attributedApplications,'Applications carrying a known acquisition source.']];
      for(const [label,value,hint] of metrics) { const el=node('article','');el.className='metric';el.append(node('span',label),node('b',fmt(value)),node('small',hint));$('metrics').append(el); }
      for(const channel of data.channels) { const tr=node('tr','');for(const value of [channel.source,channel.medium,fmt(channel.applications),fmt(channel.bookings)]) tr.append(node('td',value));$('channels').append(tr); }
      if(!data.channels.length) { const tr=node('tr','');const td=node('td','No applications or confirmed bookings recorded in this window.');td.colSpan=4;tr.append(td);$('channels').append(tr); }
      campaignReports(data);
      row($('pipeline'),'Open sales cycles',fmt(data.health.openCycles));
      row($('pipeline'),'Currently unbooked',fmt(data.health.unbookedCycles));
      for (const [key,label] of [['pendingBookingRecoveries','Booking requests being checked'],['reviewBookingRecoveries','Booking requests needing review']]) {
        const count=data.health[key];
        row($('health'),label,Number.isInteger(count) && count>=0 ? fmt(count) : 'Unavailable');
      }
      row($('health'),'Pending CRM deliveries',fmt(data.health.pendingDeliveries));
      row($('health'),'Failed CRM deliveries',fmt(data.health.failedDeliveries));
      row($('health'),'Pending provider signals',fmt(data.health.pendingSignals));
      row($('health'),'Signals requiring review',fmt(data.health.failedSignals));
      row($('health'),'Applications without source',fmt(data.summary.applications-data.summary.attributedApplications));
      row($('health'),'Last verified booking event',data.health.lastBookingEvent ? new Date(data.health.lastBookingEvent).toLocaleString() : 'None recorded');
      routingReports(data);
      $('status').textContent='Updated '+new Date(data.generatedAt).toLocaleString()+'. Window: '+data.window.start.slice(0,10)+' to '+data.window.end.slice(0,10)+' UTC.';
    } catch(error) { if(error.status===401) loggedIn(false); $('status').textContent='Reporting unavailable. No metrics have been substituted. Check the database and tracking configuration.'; }
  }
  $('login-form').addEventListener('submit',async e=>{e.preventDefault();const btn=e.target.querySelector('button');btn.disabled=true;try { await request('session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('key').value})});$('key').value='';$('login-status').textContent='';loggedIn(true);await refresh(); } catch(error) { $('login-status').textContent=error.status===503?'Dashboard access has not been configured.':'Sign-in failed. Check your access key.'; } finally { btn.disabled=false; } });
  $('logout').addEventListener('click',async()=>{try{await request('session',{method:'DELETE'});loggedIn(false);clearReport();}catch{$('status').textContent='Sign-out failed. Please retry.';}});
  $('filters').addEventListener('submit',e=>{e.preventDefault();refresh();});
  request('session').then(()=>{loggedIn(true);refresh();}).catch(error=>{loggedIn(false);if(error.status===503)$('login-status').textContent='Dashboard access has not been configured.';});
})();
