const test=require('node:test'),assert=require('node:assert/strict');
const handler=require('../api/joined');
test('new intake never treats a browser Whop success return as membership or sends legacy CRM webhook',async()=>{
 const old=process.env.LEAD_INTAKE_ENABLED,fetch=global.fetch;process.env.LEAD_INTAKE_ENABLED='true';let calls=0;global.fetch=async()=>{calls++;throw Error('unexpected provider write');};
 const res={setHeader(){},status(n){this.code=n;return this;},json(value){this.value=value;return this;}};
 try{for(const status of ['success','completed','failed','']){await handler({method:'POST',body:{email:'media@revupcmo.com',status}},res);assert.equal(res.code,200);assert.deepEqual(res.value,{ok:true,membershipVerified:false,crmSync:'unchanged'});}assert.equal(calls,0);}finally{global.fetch=fetch;if(old===undefined)delete process.env.LEAD_INTAKE_ENABLED;else process.env.LEAD_INTAKE_ENABLED=old;}
});
