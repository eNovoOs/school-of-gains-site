const test=require('node:test');
const assert=require('node:assert/strict');
const {funnelSQL,setterSQL,acquisitionReport}=require('../api/dashboard/stats');
test('optional cohort sources and attestation tables are gated before SQL parsing',async()=>{
 assert.ok(!funnelSQL(false).includes('sog_lead_captures'));assert.ok(funnelSQL(true).includes('sog_lead_captures'));
 assert.ok(!setterSQL(false).includes('sog_booking_setter_credits'));assert.ok(setterSQL(true).includes('sog_booking_setter_credits'));
 const calls=[];const range=['start','end'];const report=await acquisitionReport(async(sql,args)=>{calls.push([sql,args]);return {rows:[{report:{ok:true}}]};},range,{GHL_LEAD_SIGNALS_ENABLED:'true',SETTER_CREDIT_ENABLED:'true'});
 assert.equal(calls[0][0],funnelSQL(true));assert.equal(calls[1][0],setterSQL(true));assert.deepEqual(calls.map(c=>c[1]),[range,range]);assert.deepEqual(report,{funnel:{ok:true},setters:{ok:true}});
});
test('cohort query failures do not fabricate counts',async()=>{
 await assert.rejects(acquisitionReport(async()=>{throw Error('storage unavailable');},[],{}),/storage unavailable/);
});
