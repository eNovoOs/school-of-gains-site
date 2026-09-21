const {InputError}=require('./attribution');
function setting(value,fallback,min,max) {
 if(value===undefined || value==='')return fallback;
 const n=Number(value);if(!Number.isSafeInteger(n) || n<min || n>max)throw new InputError('worker_configuration_invalid',503);return n;
}
function configuration(env=process.env) {
 return {maxJobs:setting(env.GHL_WORKER_BATCH_SIZE,5,1,25),budgetMs:setting(env.GHL_WORKER_BUDGET_MS,15000,1000,45000)};
}
async function runBatch(processOne,{maxJobs,budgetMs}=configuration(),now=Date.now) {
 // Stop before starting another job; never interrupt a provider request or its
 // durable commit just because the soft budget expired during that job.
 const started=now();const result={processed:0,attempted:0,retryQueued:0,needsReview:0,lostLease:0,stopped:'batch_limit'};
 while(result.attempted<maxJobs) {
  if(now()-started>=budgetMs){result.stopped='time_budget';break;}
  const job=await processOne();
  if(!job.processed && !job.retryQueued && !job.needsReview && !job.lostLease){result.stopped='empty';break;}
  result.attempted++;
  result.processed+=Number(job.processed || 0);
  result.retryQueued+=Number(!!job.retryQueued);
  result.needsReview+=Number(!!job.needsReview);
  result.lostLease+=Number(!!job.lostLease);
 }
 result.durationMs=Math.max(0,now()-started);
 return result;
}
module.exports={configuration,runBatch};
