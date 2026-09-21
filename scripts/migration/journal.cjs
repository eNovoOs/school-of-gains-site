#!/usr/bin/env node
// Local-only, append-only migration evidence. Does not call GHL or Vercel.
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function required(value,label){if(!value)throw Error(`${label} is required`);return value;}
function safeId(id){if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(id||''))throw Error('Use a safe, unique change ID');return id;}
function journal(dir){return path.join(dir,'journal.jsonl');}
function entries(dir){const file=journal(dir);if(!fs.existsSync(file))throw Error('Initialize the journal first');return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}
function verify(dir){let previous=null;const rows=entries(dir);for(const item of rows){const {hash,...payload}=item;if(payload.previous!==previous||sha(JSON.stringify(payload))!==hash)throw Error('Journal chain mismatch');for(const ref of ['snapshot','rollback','after'])if(item[ref]){const p=path.join(dir,item[ref].file);if(sha(fs.readFileSync(p))!==item[ref].sha256)throw Error(`Evidence mismatch: ${item[ref].file}`);}previous=hash;}return rows;}
function append(dir,data){const rows=verify(dir);const item={timestamp:new Date().toISOString(),previous:rows.at(-1)?.hash||null,...data};item.hash=sha(JSON.stringify(item));fs.appendFileSync(journal(dir),JSON.stringify(item)+'\n',{mode:0o600});return item;}
function copy(dir,input,basename){const data=fs.readFileSync(required(input,'Evidence file'));JSON.parse(data.toString());const dest=path.join(dir,basename);fs.writeFileSync(dest,data,{flag:'wx',mode:0o600});return {file:basename,sha256:sha(data),bytes:data.length};}
function run(args){const [command,rawDir,...rest]=args;const dir=path.resolve(required(rawDir,'Private backup directory'));
 if(command==='init'){fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);fs.writeFileSync(journal(dir),'',{flag:'wx',mode:0o600});append(dir,{action:'init',locationId:'3mi3YQaZvtUMZzaQUuL6',retainedPipelines:['PSq0fv77HbtMg9bdKC2p','GxJOcIsgv7Svx90E2BZr']});return 'Journal initialized';}
 if(command==='verify')return {valid:true,entries:verify(dir).length};
 if(command==='prepare'){const [rawId,resourceType,resourceId,before,rollback,reason]=rest;const id=safeId(rawId);if(verify(dir).some(x=>x.id===id))throw Error('Change ID already exists');required(resourceType,'Resource type');required(resourceId,'Resource ID');required(reason,'Reason');const rollbackData=json(required(rollback,'Rollback recipe'));if(!rollbackData.restoreSteps||!Array.isArray(rollbackData.restoreSteps)||!rollbackData.restoreSteps.length)throw Error('Rollback recipe needs nonempty restoreSteps');const snapshot=copy(dir,before,`${id}.before.json`);const rollbackRef=copy(dir,rollback,`${id}.rollback.json`);return append(dir,{action:'prepared',id,resourceType,resourceId,reason,snapshot,rollback:rollbackRef});}
 if(['applied','restored'].includes(command)){const [rawId,after,note]=rest;const id=safeId(rawId);const rows=verify(dir);if(!rows.some(x=>x.action==='prepared'&&x.id===id))throw Error('No verified before snapshot for this change');if(rows.some(x=>x.action===command&&x.id===id))throw Error(`${command} already recorded`);if(command==='restored'&&!rows.some(x=>x.action==='applied'&&x.id===id))throw Error('No applied change to restore');const afterRef=copy(dir,after,`${id}.${command}.json`);return append(dir,{action:command,id,note:required(note,'Verification note'),after:afterRef});}
 if(command==='status'){const rows=verify(dir);return rows.filter(x=>x.action==='prepared').map(item=>({id:item.id,resourceType:item.resourceType,resourceId:item.resourceId,status:rows.filter(x=>x.id===item.id).at(-1).action,rollback:item.rollback.file}));}
 throw Error('Commands: init DIR | prepare DIR ID TYPE RESOURCE_ID BEFORE_JSON ROLLBACK_JSON REASON | applied DIR ID AFTER_JSON NOTE | restored DIR ID RESTORED_JSON NOTE | verify DIR | status DIR');
}
if(require.main===module){try{console.log(JSON.stringify(run(process.argv.slice(2)),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={run,verify};
