import {operationContext,queuedTerminalStateSQL,queuedActiveJobsSQL} from './ai-cancellation.ts';
export const jobKinds = {
 capture:{table:'jobs',key:'id',generation:'version',message:'job_id'},
 graph:{table:'graph_jobs',key:'id',generation:'version',message:'graph_job_id'},
 theme:{table:'theme_jobs',key:'id',generation:'version',message:'theme_job_id'},
 research:{table:'research_runs',key:'id',generation:'created_at',message:'research_id'},
 import:{table:'import_jobs',key:'id',generation:'created_at',message:'import_job_id'},
 embedding:{table:'embedding_jobs',key:'capture_id',generation:'version',message:'embedding_capture_id'},
 bibliography:{table:'bibliography_jobs',key:'capture_id',generation:'version',message:'bibliography_capture_id'},
 reflection:{table:'reflection_jobs',key:'id',generation:'signature',message:'reflection_job_id'},
} as const;
export type JobKind=keyof typeof jobKinds;
type JobRow=Record<string,unknown>&{state:string};
export async function beginOperationLease(env:Env,id:string){const token=crypto.randomUUID();await env.DB.prepare('INSERT INTO ai_operation_leases VALUES(?,?,?)').bind(token,id,Date.now()+900000).run();return token;}
export async function endOperationLease(env:Env,token:string){await env.DB.prepare('DELETE FROM ai_operation_leases WHERE token=?').bind(token).run();}
export type Operation={id:string;path:string;label:string;mode:string;state:string;created_at:number;updated_at:number;workflow?:string|null;target_id?:string|null;stage?:string|null;response_json?:string|null;response_status?:number|null};
export const getOperation=(env:Env,id:string)=>env.DB.prepare('SELECT * FROM ai_operations WHERE id=?').bind(id).first<Operation>();
// An active job has one canonical owner. A duplicate tab may observe it, never
// steal it. Explicit retries can acquire only a terminal owner's generation.
async function link(env:Env,id:string,kind:JobKind,key:string,replace=false){
 const c=jobKinds[kind];
 await env.DB.prepare(`INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
 SELECT ?,${c.key},CAST(${c.generation} AS TEXT),? FROM ${c.table} WHERE ${c.key}=?
 ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
 WHERE ?=1 AND (EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'))${kind==='capture'?" OR EXISTS(SELECT 1 FROM jobs j WHERE j.id=ai_operation_jobs.job_id AND j.state='blocked' AND NOT EXISTS(SELECT 1 FROM explicit_ai_actions a WHERE a.kind='extract' AND a.target_id=j.capture_id AND a.version=j.version))":''})`).bind(kind,id,key,replace?1:0).run();
 return env.DB.prepare(`SELECT o.* FROM ai_operations o JOIN ai_operation_jobs l ON l.operation_id=o.id
 JOIN ${c.table} j ON j.${c.key}=l.job_id AND CAST(j.${c.generation} AS TEXT)=l.generation
 WHERE l.kind=? AND l.job_id=?`).bind(kind,key).first<Operation>();
}
export async function claimExistingRoot(env:Env,op:Operation,path:string,input:Record<string,any>={}){
 const capture=/^\/api\/captures\/([^/]+)\/(extract|retry)$/.exec(path);
 if(capture){
  const job=await env.DB.prepare('SELECT j.id FROM jobs j JOIN captures c ON c.id=j.capture_id AND c.version=j.version WHERE c.id=? AND c.version=?').bind(capture[1],Number(input.version)).first<{id:string}>();
  return job?link(env,op.id,'capture',job.id,true):null;
 }
 if(path==='/api/graph/rebuild'&&Array.isArray(input.capture_ids)){
  // Exact duplicate batches are canonicalized before this point. An overlapping
  // batch must not silently drop unowned targets or seize another active batch.
  return env.DB.prepare(`SELECT o.* FROM graph_jobs j JOIN captures c ON c.id=j.capture_id AND c.version=j.version JOIN ai_operation_jobs l ON l.kind='graph' AND l.job_id=j.id AND l.generation=CAST(j.version AS TEXT) JOIN ai_operations o ON o.id=l.operation_id
   WHERE c.id IN (SELECT value FROM json_each(?)) AND o.id<>? AND o.state IN ('running','queued') AND j.state IN ('pending','running','blocked') LIMIT 1`).bind(JSON.stringify(input.capture_ids),op.id).first<Operation>();
 }
 const existing=/^\/api\/(imports|research)\/([^/]+)\/(extract|retry)$/.exec(path);
 return existing?link(env,op.id,existing[1]==='imports'?'import':'research',existing[2],true):null;
}

async function owned(env:Env,id:string){
 const entries=Object.entries(jobKinds) as [JobKind,typeof jobKinds[JobKind]][];
 const result=await env.DB.batch(entries.map(([kind,c])=>env.DB.prepare(`SELECT j.* FROM ${c.table} j JOIN ai_operation_jobs l
 ON l.kind=? AND l.job_id=j.${c.key} AND l.generation=CAST(j.${c.generation} AS TEXT) WHERE l.operation_id=?`).bind(kind,id)));
 return entries.flatMap(([kind],i)=>(result[i].results as JobRow[]).map(row=>({kind,row})));
}
export async function attachRootJob(env:Env,op:Operation,path:string,data:Record<string,any>,input:Record<string,any>={}){
 const value=data.data||data;
 if(path==='/api/graph/rebuild'){
  for(const capture of Array.isArray(input.capture_ids)?input.capture_ids:[]){
   const result=await env.DB.prepare('SELECT j.id FROM graph_jobs j JOIN captures c ON c.id=j.capture_id AND c.version=j.version WHERE c.id=?').bind(String(capture)).all<{id:string}>();
   for(const job of result.results)await link(env,op.id,'graph',job.id,true);
  }
 }else if(path.startsWith('/api/themes/')&&path.endsWith('/rebuild')&&value.job_id)await link(env,op.id,'theme',String(value.job_id),true);
 else if(path.startsWith('/api/research'))await link(env,op.id,'research',String(value.id||path.split('/')[3]),true);
 else if(path.startsWith('/api/imports'))await link(env,op.id,'import',String(value.id||path.split('/')[3]),true);
 else if(path.startsWith('/api/captures')){
  const capture=String(path==='/api/captures'?value.id:path.split('/')[3]);
  const job=await env.DB.prepare('SELECT j.id FROM jobs j JOIN captures c ON c.id=j.capture_id AND c.version=j.version WHERE c.id=?').bind(capture).first<{id:string}>();
  if(job)await link(env,op.id,'capture',job.id,true);
 }
}
export async function attachChildJobs(env:Env,id:string){
 const jobs=await owned(env,id),captures=new Map<string,number>(),themes=new Set<string>();
 for(const {kind,row} of jobs){
  if(['capture','graph','embedding','bibliography'].includes(kind)&&typeof row.capture_id==='string')captures.set(row.capture_id,Number(row.version));
  if(kind==='theme'){if(row.kind==='membership')captures.set(String(row.target_id),Number(row.version));}
  if(kind==='import'||kind==='research'){
   const table=kind==='import'?'import_items':'research_materials',key=kind==='import'?'job_id':'run_id';
   const r=await env.DB.prepare(`SELECT capture_id FROM ${table} WHERE ${key}=? AND capture_id IS NOT NULL${kind==='research'?" AND state='saved'":''}`).bind(row.id).all<{capture_id:string}>();
   for(const x of r.results)captures.set(x.capture_id,1);
  }
 }
 for(const [capture,version] of captures){
  for(const kind of ['capture','graph','embedding','bibliography'] as const){
   if((kind==='embedding'||kind==='bibliography')&&env.AI_EXECUTION_POLICY!=='automatic_legacy')continue;
   const c=jobKinds[kind];
   const found=await env.DB.prepare(`SELECT j.${c.key} AS id FROM ${c.table} j JOIN captures c ON c.id=j.capture_id AND c.version=j.version WHERE c.id=? AND j.version=? AND j.state IN ('pending','running','blocked')`).bind(capture,version).all<{id:string}>();
   for(const job of found.results)await link(env,id,kind,job.id);
  }
  const members=await env.DB.prepare("SELECT id FROM theme_jobs WHERE kind='membership' AND target_id=? AND version=? AND state IN ('pending','running','blocked') AND (?=1 OR EXISTS(SELECT 1 FROM explicit_ai_actions a WHERE a.kind='membership' AND a.target_id=theme_jobs.target_id AND a.version=theme_jobs.version))").bind(capture,version,env.AI_EXECUTION_POLICY==='automatic_legacy'?1:0).all<{id:string}>();
  for(const job of members.results)await link(env,id,'theme',job.id);
  if(env.AI_EXECUTION_POLICY==='automatic_legacy'){
   const memberships=await env.DB.prepare('SELECT theme_id FROM theme_memberships WHERE capture_id=? AND capture_version=?').bind(capture,version).all<{theme_id:string}>();
   for(const t of memberships.results)themes.add(t.theme_id);
  }
 }
 for(const theme of themes){
  const result=await env.DB.prepare("SELECT id FROM theme_jobs WHERE kind='synthesis' AND target_id=? AND state IN ('pending','running','blocked')").bind(theme).all<{id:string}>();
  for(const job of result.results)await link(env,id,'theme',job.id);
 }
}
export async function cancelOperationJobs(env:Env,id:string){
 const queued=(Object.entries(jobKinds) as [JobKind,typeof jobKinds[JobKind]][]).map(([kind,c])=>env.DB.prepare(`UPDATE ${c.table} SET state='canceled',lease_token=NULL
 WHERE state IN ('pending','running','blocked') AND EXISTS(SELECT 1 FROM ai_operation_jobs l WHERE l.operation_id=? AND l.kind=? AND l.job_id=${c.table}.${c.key} AND l.generation=CAST(${c.table}.${c.generation} AS TEXT))`).bind(id,kind));
 const inline=[['discovery','discovery_runs'],['integration','integration_runs'],['proposals','integration_proposal_runs']].map(([kind,table])=>env.DB.prepare(`UPDATE ${table} SET state='failed',error='AI処理を停止しました。'
 WHERE state='running' AND EXISTS(SELECT 1 FROM ai_operation_records r WHERE r.operation_id=? AND r.kind=? AND r.record_id=${table}.id)`).bind(id,kind));
 inline.push(env.DB.prepare(`UPDATE integration_proposals SET state='failed',error='AI処理を停止しました。'
 WHERE state='running' AND EXISTS(SELECT 1 FROM ai_operation_records r WHERE r.operation_id=? AND r.kind='proposal' AND r.record_id=integration_proposals.id AND r.attempt=integration_proposals.attempt)
 AND NOT EXISTS(SELECT 1 FROM integration_runs i WHERE i.request_key='proposal:'||integration_proposals.id||':'||integration_proposals.attempt AND i.state='completed')`).bind(id));
 // A child result committed before its aggregate stop remains completed, even if
 // the parent request disappeared before updating this denormalized receipt.
 inline.push(env.DB.prepare(`UPDATE integration_proposals SET state='completed',error=NULL,result_json=(SELECT json_set(i.result_json,'$.id',i.id,'$.state','completed') FROM integration_runs i WHERE i.request_key='proposal:'||integration_proposals.id||':'||integration_proposals.attempt AND i.state='completed')
 WHERE state='running' AND EXISTS(SELECT 1 FROM ai_operation_records r WHERE r.operation_id=? AND r.kind='proposal' AND r.record_id=integration_proposals.id AND r.attempt=integration_proposals.attempt)
 AND EXISTS(SELECT 1 FROM integration_runs i WHERE i.request_key='proposal:'||integration_proposals.id||':'||integration_proposals.attempt AND i.state='completed')`).bind(id));
 inline.push(env.DB.prepare(`UPDATE book_operation_receipts SET state='interrupted' WHERE state='running'
 AND EXISTS(SELECT 1 FROM ai_operation_records r WHERE r.operation_id=? AND r.kind='receipt' AND r.record_id=book_operation_receipts.operation_key)`).bind(id));
 await env.DB.batch([...queued,...inline]);
}

export async function operationForMessage(env:Env,body:unknown){
 if(!body||typeof body!=='object')return null;
 for(const [kind,c] of Object.entries(jobKinds)){
  const key=(body as Record<string,unknown>)[c.message];if(typeof key!=='string')continue;
  return env.DB.prepare(`SELECT o.* FROM ai_operations o JOIN ai_operation_jobs l ON l.operation_id=o.id JOIN ${c.table} j ON j.${c.key}=l.job_id AND CAST(j.${c.generation} AS TEXT)=l.generation
   WHERE l.kind=? AND l.job_id=? AND NOT(o.state='completed' AND ?=1 AND j.state IN ('pending','running','blocked'))`).bind(kind,key,env.AI_EXECUTION_POLICY==='automatic_legacy'?1:0).first<Operation>();
 }
 return null;
}
export async function operationSnapshot(env:Env,id:string){
 let op=await getOperation(env,id);if(!op)return null;
 const jobs=await owned(env,id),active=jobs.filter(({row})=>['pending','running','blocked'].includes(row.state));
 const leased=await env.DB.prepare('SELECT 1 FROM ai_operation_leases WHERE operation_id=? AND expires_at>? LIMIT 1').bind(id,Date.now()).first();
 if(!leased&&op.mode!=='inline'&&['running','queued'].includes(op.state)&&(jobs.length||await env.DB.prepare('SELECT 1 FROM ai_operation_jobs WHERE operation_id=? LIMIT 1').bind(id).first())){
   await env.DB.prepare(`UPDATE ai_operations SET state=CASE WHEN (${queuedTerminalStateSQL})='completed' AND workflow='text-discovery' AND stage='extracting' THEN 'queued' ELSE ${queuedTerminalStateSQL} END,updated_at=? WHERE id=? AND state IN ('running','queued') AND NOT ${queuedActiveJobsSQL(env.AI_EXECUTION_POLICY!=='automatic_legacy')} AND NOT EXISTS(SELECT 1 FROM ai_operation_leases WHERE operation_id=? AND expires_at>?)`).bind(Date.now(),id,id,Date.now()).run();
  op=(await getOperation(env,id))!;
 }
 const phase=!['running','queued'].includes(op.state)?op.state:op.mode==='inline'?'running':active.some(({row})=>row.state==='running')?'running':active.some(({row})=>row.state==='blocked')?'blocked':'queued';
 return {id:op.id,path:op.path,label:op.label,mode:op.mode,state:phase,workflow:op.workflow||null,stage:op.stage||null,target_id:op.target_id||null,updated_at:op.updated_at};
}
export async function finishQueuedRegistration(env:Env,id:string){
 const op=await getOperation(env,id);if(!op)return;
 if(op.state==='canceled'){await cancelOperationJobs(env,id);return;}
 const jobs=await owned(env,id);
 if(!jobs.length&&op.workflow!=='text-discovery')await env.DB.prepare("UPDATE ai_operations SET state='completed',updated_at=? WHERE id=? AND state IN ('running','queued')").bind(Date.now(),id).run();
 else await operationSnapshot(env,id);
}
// Older/detail-page stop controls resolve the same
// durable owner even when this tab has not polled the operation list yet.
export async function cancelLinkedOperation(env:Env,kind:JobKind,key:string,generation?:string){
 const c=jobKinds[kind];
 const owner=await env.DB.prepare(`SELECT o.* FROM ai_operations o JOIN ai_operation_jobs l ON l.operation_id=o.id
 JOIN ${c.table} j ON j.${c.key}=l.job_id AND CAST(j.${c.generation} AS TEXT)=l.generation
 WHERE l.kind=? AND l.job_id=? AND (? IS NULL OR l.generation=?)`).bind(kind,key,generation??null,generation??null).first<Operation>();
 if(!owner)return null;
 await operationSnapshot(env,owner.id);
 await env.DB.prepare("UPDATE ai_operations SET state='canceled',updated_at=? WHERE id=? AND state IN ('running','queued')").bind(Date.now(),owner.id).run();
 if((await getOperation(env,owner.id))?.state==='canceled')await cancelOperationJobs(env,owner.id);
 return operationSnapshot(env,owner.id);
}

// Existing MCP/direct retry entrypoints have no Web operation header. Give an
// explicit retry its own durable owner, so a delayed old delivery cannot reclaim
// or cancel the new attempt. Cron/queue delivery never invokes this function.
export async function renewTerminalJobOwner(env:Env,kind:JobKind,key:string,statements:D1PreparedStatement[]){
 if(operationContext(env))return env.DB.batch(statements);
 const next=crypto.randomUUID(),time=Date.now();
 // The new owner and retryable job state must become visible together.
 // Otherwise a status read can finalize the owner from the previous attempt.
 const result=await env.DB.batch([
  env.DB.prepare(`INSERT INTO ai_operations(id,path,label,mode,state,created_at,updated_at)
   SELECT ?,?,'再試行','queued','queued',?,? WHERE EXISTS(SELECT 1 FROM ai_operation_jobs l JOIN ai_operations o ON o.id=l.operation_id WHERE l.kind=? AND l.job_id=? AND o.state IN ('completed','failed','canceled'))`).bind(next,`connector:retry/${kind}/${key}`,time,time,kind,key),
  env.DB.prepare(`UPDATE ai_operation_jobs SET operation_id=? WHERE kind=? AND job_id=? AND EXISTS(SELECT 1 FROM ai_operations WHERE id=?) AND EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'))`).bind(next,kind,key,next),
  ...statements,
 ]);
 return result.slice(2);
}
