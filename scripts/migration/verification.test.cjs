const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const auth=require('../../lib/dashboard-auth');const {run}=require('./journal.cjs');
test('dashboard sessions reject missing configuration, tampering and key rotation',()=>{
 const saved={...process.env};delete process.env.DASHBOARD_ACCESS_KEY;delete process.env.DASHBOARD_SESSION_SECRET;
 assert.equal(auth.authenticated({headers:{}}),false);
 process.env.DASHBOARD_ACCESS_KEY='a'.repeat(40);process.env.DASHBOARD_SESSION_SECRET='b'.repeat(40);
 let cookie;auth.setSession({setHeader:(_,value)=>cookie=value});assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
 const req={headers:{cookie:cookie.split(';')[0]}};assert.equal(auth.authenticated(req),true);
 assert.equal(auth.authenticated({headers:{cookie:req.headers.cookie+'bad'}}),false);
 process.env.DASHBOARD_SESSION_SECRET='c'.repeat(40);assert.equal(auth.authenticated(req),false);
 process.env.APP_ORIGIN='https://school-of-gains.com';assert.equal(auth.sameOrigin({headers:{origin:'https://attacker.example'}}),false);assert.equal(auth.sameOrigin({headers:{}}),false);assert.equal(auth.sameOrigin({headers:{origin:'https://school-of-gains.com'}}),true);
 for(const key of ['DASHBOARD_ACCESS_KEY','DASHBOARD_SESSION_SECRET','APP_ORIGIN']) saved[key]===undefined?delete process.env[key]:process.env[key]=saved[key];
});
test('migration refuses writes without snapshot and detects evidence tampering',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sog-journal-test-'));const backup=path.join(dir,'backup');
 try{run(['init',backup]);assert.throws(()=>run(['applied',backup,'x','missing','note']),/No verified before snapshot/);
 const before=path.join(dir,'before.json');const rollback=path.join(dir,'rollback.json');const after=path.join(dir,'after.json');fs.writeFileSync(before,JSON.stringify({name:'Original',status:'published'}));fs.writeFileSync(rollback,JSON.stringify({restoreSteps:['Restore original name and status']}));fs.writeFileSync(after,JSON.stringify({name:'Old',status:'draft'}));
 run(['prepare',backup,'x','workflow','workflow-id',before,rollback,'test']);run(['applied',backup,'x',after,'verified']);assert.equal(run(['verify',backup]).valid,true);assert.equal(run(['status',backup])[0].status,'applied');
 fs.writeFileSync(path.join(backup,'x.before.json'),'{}');assert.throws(()=>run(['verify',backup]),/Evidence mismatch/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('dashboard stats are blocked before querying data',async()=>{
 const stats=require('../../api/dashboard/stats');let status,body;const res={setHeader(){},status(value){status=value;return this;},json(value){body=value;return this;}};
 const key=process.env.DASHBOARD_ACCESS_KEY,secret=process.env.DASHBOARD_SESSION_SECRET;process.env.DASHBOARD_ACCESS_KEY='a'.repeat(40);process.env.DASHBOARD_SESSION_SECRET='b'.repeat(40);
 await stats({method:'GET',headers:{},query:{}},res);assert.equal(status,401);assert.equal(body.error,'unauthorized');
 key===undefined?delete process.env.DASHBOARD_ACCESS_KEY:process.env.DASHBOARD_ACCESS_KEY=key;secret===undefined?delete process.env.DASHBOARD_SESSION_SECRET:process.env.DASHBOARD_SESSION_SECRET=secret;
});
