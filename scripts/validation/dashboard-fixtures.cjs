const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {SQL}=require('../../api/dashboard/stats');
module.exports=async function validateDashboard(db,contactId,cycleId,journeyId){
 const touch=(campaign,content)=>({firstTouch:{source:'wrong-first',utm_campaign:'wrong-first'},latestTouch:{source:'youtube',medium:'organic_social',utm_campaign:campaign,utm_content:content}});
 const start='2001-02-01T00:00:00Z',end='2001-03-01T00:00:00Z';
 for(const [campaign,content] of [['alpha','video-a'],['beta','video-b'],['beta','video-b']]){
 const id=randomUUID();await db.query("INSERT INTO sog_events(event_id,type,contact_id,journey_id,payload) VALUES($1,'quiz_submitted',$2,$3,'{}')",[id,contactId,journeyId]);
 await db.query("INSERT INTO sog_applications(id,contact_id,cycle_id,journey_id,quiz_version,answers,consent,attribution,created_at) VALUES($1,$2,$3,$4,'test','{}','{}',$5,'2001-02-05T00:00:00Z')",[id,contactId,cycleId,journeyId,touch(campaign,content)]);
 }
 const statuses=['new','confirmed','cancelled','invalid','showed','noshow'];
 for(let i=0;i<7;i++){
  const id='dashboard-fixture-'+i,status=statuses[i] || 'confirmed';
  await db.query("INSERT INTO sog_appointments(id,contact_id,cycle_id,calendar_id,status,starts_at,updated_at,attribution) VALUES($1,$2,$3,'test',$4,'2001-04-01T00:00:00Z','2001-04-01T00:00:00Z',$5)",[id,contactId,cycleId,status,touch(i%2?'beta':'alpha',i%2?'video-b':'video-a')]);
  // Repeated confirmations/reschedules of one appointment must count once.
  for(const date of [i===6?'2001-01-31T00:00:00Z':'2001-02-05T00:00:00Z','2001-02-10T00:00:00Z'])await db.query("INSERT INTO sog_events(event_id,type,contact_id,occurred_at,payload) VALUES($1,'appointment_confirmed',$2,$3,$4)",[randomUUID(),contactId,date,{appointmentId:id}]);
 }
 const report=(await db.query(SQL,[start,end])).rows[0].report;
 assert.equal(report.summary.applications,3);assert.equal(report.summary.bookings,6);
 assert.deepEqual(report.channels,[{source:'youtube',medium:'organic_social',applications:3,bookings:6}]);
 assert.deepEqual(report.campaigns,[{source:'youtube',medium:'organic_social',campaign:'beta',content:'video-b',applications:2,bookings:3},{source:'youtube',medium:'organic_social',campaign:'alpha',content:'video-a',applications:1,bookings:3}]);
 assert.deepEqual(report.outcomes,{active:2,cancelled:2,attended:1,missed:1,other:0});
 assert.equal(Object.values(report.outcomes).reduce((a,b)=>a+b,0),report.summary.bookings);
 assert.equal(JSON.stringify(report.campaigns).includes('wrong-first'),false);
};
