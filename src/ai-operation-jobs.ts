export const jobKinds = {
 capture:{table:'jobs',key:'id',generation:'version',message:'job_id'},
 graph:{table:'graph_jobs',key:'id',generation:'version',message:'graph_job_id'},
 theme:{table:'theme_jobs',key:'id',generation:'version',message:'theme_job_id'},
 research:{table:'research_runs',key:'id',generation:'created_at',message:'research_id'},
 import:{table:'import_jobs',key:'id',generation:'created_at',message:'import_job_id'},
 embedding:{table:'embedding_jobs',key:'capture_id',generation:'version',message:'embedding_capture_id'},
} as const;
export type JobKind=keyof typeof jobKinds;
type JobRow=Record<string,unknown>&{state:string};
export async function beginOperationLease(env:Env,id:string){const token=crypto.randomUUID();await env.DB.prepare('INSERT INTO ai_operation_leases VALUES(?,?,?)').bind(token,id,Date.now()+900000).run();return token;}
export async function endOperationLease(env:Env,token:string){await env.DB.prepare('DELETE FROM ai_operation_leases WHERE token=?').bind(token).run();}
export type Operation={id:string;path:string;label:string;mode:string;state:string;created_at:number;updated_at:number};
export const getOperation=(env:Env,id:string)=>env.DB.prepare('SELECT * FROM ai_operations WHERE id=?').bind(id).first<Operation>();
async function link(env:Env,id:string,kind:JobKind,key:string,replace=false){
 const c=jobKinds[kind];
 await env.DB.prepare(`INSERT ${replace?'OR REPLACE':'OR IGNORE'} INTO ai_operation_jobs(kind,job_id,generation,operation_id)
 SELECT ?,${c.key},CAST(${c.generation} AS TEXT),? FROM ${c.table} WHERE ${c.key}=?`).bind(kind,id,key).run();
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
  if(['capture','graph','embedding'].includes(kind)&&typeof row.capture_id==='string')captures.set(row.capture_id,Number(row.version));
  if(kind==='theme'){if(row.kind==='membership')captures.set(String(row.target_id),Number(row.version));}
  if(kind==='import'||kind==='research'){
   const table=kind==='import'?'import_items':'research_materials',key=kind==='import'?'job_id':'run_id';
   const r=await env.DB.prepare(`SELECT capture_id FROM ${table} WHERE ${key}=? AND capture_id IS NOT NULL${kind==='research'?" AND state='saved'":''}`).bind(row.id).all<{capture_id:string}>();
   for(const x of r.results)captures.set(x.capture_id,1);
  }
 }
 for(const [capture,version] of captures){
  for(const kind of ['capture','graph','embedding'] as const){
   if(kind==='embedding'&&env.AI_EXECUTION_POLICY!=='automatic_legacy')continue;
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
 await env.DB.batch((Object.entries(jobKinds) as [JobKind,typeof jobKinds[JobKind]][]).map(([kind,c])=>env.DB.prepare(`UPDATE ${c.table} SET state='canceled',lease_token=NULL
 WHERE state IN ('pending','running','blocked') AND EXISTS(SELECT 1 FROM ai_operation_jobs l WHERE l.operation_id=? AND l.kind=? AND l.job_id=${c.table}.${c.key} AND l.generation=CAST(${c.table}.${c.generation} AS TEXT))`).bind(id,kind)));
}
export async function operationForMessage(env:Env,body:unknown){
 if(!body||typeof body!=='object')return null;
 for(const [kind,c] of Object.entries(jobKinds)){
  const key=(body as Record<string,unknown>)[c.message];if(typeof key!=='string')continue;
  return env.DB.prepare(`SELECT o.* FROM ai_operations o JOIN ai_operation_jobs l ON l.operation_id=o.id JOIN ${c.table} j ON j.${c.key}=l.job_id AND CAST(j.${c.generation} AS TEXT)=l.generation
   WHERE l.kind=? AND l.job_id=? AND o.state IN ('running','queued','canceled')`).bind(kind,key).first<Operation>();
 }
 return null;
}
export async function operationSnapshot(env:Env,id:string){
 let op=await getOperation(env,id);if(!op)return null;
 const jobs=await owned(env,id),active=jobs.filter(({row})=>['pending','running','blocked'].includes(row.state));
 const leased=await env.DB.prepare('SELECT 1 FROM ai_operation_leases WHERE operation_id=? AND expires_at>? LIMIT 1').bind(id,Date.now()).first();
 if(!leased&&op.mode!=='inline'&&['running','queued'].includes(op.state)&&jobs.length&&!active.length){
  const state=jobs.some(({row})=>['failed','partial'].includes(row.state))?'failed':'completed';
  await env.DB.prepare("UPDATE ai_operations SET state=?,updated_at=? WHERE id=? AND state IN ('running','queued')").bind(state,Date.now(),id).run();
  op=(await getOperation(env,id))!;
 }
 const phase=!['running','queued'].includes(op.state)?op.state:op.mode==='inline'?'running':active.some(({row})=>row.state==='running')?'running':active.some(({row})=>row.state==='blocked')?'blocked':'queued';
 return {id:op.id,label:op.label,mode:op.mode,state:phase,updated_at:op.updated_at};
}
export async function finishQueuedRegistration(env:Env,id:string){
 const op=await getOperation(env,id);if(!op)return;
 if(op.state==='canceled'){await cancelOperationJobs(env,id);return;}
 const jobs=await owned(env,id);
 if(!jobs.length)await env.DB.prepare("UPDATE ai_operations SET state='completed',updated_at=? WHERE id=? AND state IN ('running','queued')").bind(Date.now(),id).run();
 else await operationSnapshot(env,id);
}
