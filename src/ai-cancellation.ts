type OperationContext = {id:string; db:D1Database; complete:boolean|'queued'};
const contexts = new WeakMap<object,OperationContext>();
export class AIOperationCanceled extends Error {
 readonly canceled = true;
 constructor(){super('AI処理を停止しました。');}
}
export function operationContext(env:Env){return contexts.get(env);}
export async function assertOperationActive(context:OperationContext){
 const row=await context.db.prepare('SELECT state FROM ai_operations WHERE id=?').bind(context.id).first<{state:string}>();
 if(!row||!['running','queued'].includes(row.state))throw new AIOperationCanceled();
}
function guardedDatabase(db:D1Database,id:string,preserveOriginal=false):D1Database {
 const originals=new WeakMap<object,D1PreparedStatement>();
 const mutations=new WeakMap<object,boolean>();
 // Accounting and OAuth credential rotation must survive cancellation.
 const guarded=(sql:string)=>!/^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql)&&!/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE)\s+(?:ai_calls|ai_daily|chatgpt_sessions)\b/i.test(sql);
 const execute=async(statements:D1PreparedStatement[])=>{
  const needsFence=statements.some(s=>mutations.get(s)!==false);
  const raw=statements.map(s=>originals.get(s)||s);
  if(!needsFence)return db.batch(raw);
  const marker=preserveOriginal?'ai_operation_registrations':'ai_operation_fences';
  const results=await db.batch([db.prepare(`INSERT OR REPLACE INTO ${marker}(operation_id) VALUES(?)`).bind(id),...raw,db.prepare(`DELETE FROM ${marker} WHERE operation_id=?`).bind(id)]);
  return results.slice(1,-1);
 };
 const wrap=(statement:D1PreparedStatement,write:boolean):D1PreparedStatement=>{
  const proxy=new Proxy(statement,{
   get(target,key){
    if(key==='bind')return (...values:unknown[])=>wrap(target.bind(...values),write);
    if(write&&['run','all','first','raw'].includes(String(key)))return async(...args:unknown[])=>{
     const result=(await execute([proxy]))[0];
     if(key==='first'){const row=result.results?.[0] as Record<string,unknown>|undefined;return args[0]?(row?.[String(args[0])]??null):(row??null);}
     if(key==='raw'){
      const rows=result.results as Record<string,unknown>[];
      if(!rows.length)return [];
      const names=Object.keys(rows[0]),values=rows.map(r=>names.map(n=>r[n]));
      return (args[0] as {columnNames?:boolean})?.columnNames?[names,...values]:values;
     }
     return result;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }
  });
  originals.set(proxy,statement);mutations.set(proxy,write);return proxy;
 };
 return new Proxy(db,{
  get(target,key){
   if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql),guarded(sql));
   if(key==='batch')return execute;
   if(key==='exec'||key==='withSession')return ()=>{throw new Error('Use prepared statements inside an AI operation');};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }
 });
}
export function scopeAIOperation(env:Env,id:string,complete:boolean|'queued'=true):Env {
 const scoped={...env,DB:guardedDatabase(env.DB,id)};
 contexts.set(scoped,{id,db:env.DB,complete});return scoped;
}
// Save original material while atomically assigning its queued AI ownership.
// Cancellation fences the queue consumer, never this original-input transaction.
export function scopeOriginalIngestion(env:Env,id:string):Env {
 const scoped={...env,DB:guardedDatabase(env.DB,id,true)};
 contexts.set(scoped,{id,db:env.DB,complete:false});return scoped;
}
// Cleanup is deliberately explicit: only terminal bookkeeping may use this raw DB.
// Never write generated results or user material through it.
export function cancellationCleanup(env:Env):Env {const context=contexts.get(env);return context?{...env,DB:context.db}:env;}
export async function isOperationCanceled(env:Env){const context=contexts.get(env);return Boolean(context&&(await context.db.prepare('SELECT state FROM ai_operations WHERE id=?').bind(context.id).first<{state:string}>())?.state==='canceled');}
export async function throwIfOperationCanceled(env:Env){const context=contexts.get(env);if(context)await assertOperationActive(context);}
export function nestedOperation(env:Env):Env {const context=contexts.get(env);if(!context)return env;const nested={...env};contexts.set(nested,{...context,complete:false});return nested;}
export const queuedTerminalStateSQL=`CASE WHEN EXISTS(SELECT 1 FROM ai_operation_job_states j WHERE j.operation_id=ai_operations.id AND j.state IN ('failed','partial','superseded')) OR EXISTS(SELECT 1 FROM ai_operation_jobs l LEFT JOIN ai_operation_job_states j ON j.operation_id=l.operation_id AND j.kind=l.kind AND j.job_id=l.job_id AND j.generation=l.generation WHERE l.operation_id=ai_operations.id AND j.job_id IS NULL) THEN 'failed' WHEN EXISTS(SELECT 1 FROM ai_operation_job_states j WHERE j.operation_id=ai_operations.id AND j.state IN ('canceled','cancelled')) THEN 'canceled' ELSE 'completed' END`;
export const queuedActiveJobsSQL=(explicit=true)=>`EXISTS(SELECT 1 FROM ai_operation_job_states j WHERE j.operation_id=ai_operations.id AND j.state IN ('pending','running','blocked')${explicit?" AND (j.kind IN ('research','import') OR EXISTS(SELECT 1 FROM explicit_ai_actions a WHERE a.kind=j.action_kind AND a.target_id=j.target_id AND (j.kind='import' OR CAST(a.version AS TEXT)=j.generation)))":""})`;
// Commit output and its terminal state together: whichever transaction wins,
// cancellation or output, is reported truthfully. Nested batch items stay active.
export async function commitAIResult(env:Env,statements:D1PreparedStatement[]){
 const context=contexts.get(env);
 if(!context||!context.complete)return statements.length?env.DB.batch(statements):[];
 const queued=context.complete==='queued';
 const result=await env.DB.batch([...statements,env.DB.prepare(`UPDATE ai_operations SET state=${queued?queuedTerminalStateSQL:"'completed'"},updated_at=? WHERE id=? AND state IN ('running','queued')${statements.length?" AND changes()>0":""}${queued?` AND NOT ${queuedActiveJobsSQL()}`:''}`).bind(Date.now(),context.id)]);
 return result.slice(0,-1);
}
export async function cancellableAI<T>(env:Env,fetcher:typeof fetch,execute:(fetcher:typeof fetch)=>Promise<T>):Promise<T>{
 const context=contexts.get(env);if(!context)return execute(fetcher);
 await assertOperationActive(context);
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
 const check=async()=>{
  try{await assertOperationActive(context);}catch(e){controller.abort(e);}
  if(!disposed&&!controller.signal.aborted)timer=setTimeout(check,1000);
 };
 timer=setTimeout(check,1000);
 const guardedFetch:typeof fetch=async(input,init)=>{
  // A refresh token may already have rotated at the issuer. Finish and persist
  // that exchange; cancel the inference, not the credentials needed next time.
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.pathname.endsWith('/oauth/token'))return fetcher(input,init);
  await assertOperationActive(context);
  return fetcher(input,{...init,signal:AbortSignal.any([controller.signal,...(init?.signal?[init.signal]:input instanceof Request?[input.signal]:[])])});
 };
 try{
  const result=await execute(guardedFetch);
  await assertOperationActive(context);
  return result;
 }catch(e){await assertOperationActive(context);throw e;}
 finally{disposed=true;clearTimeout(timer);}
}
