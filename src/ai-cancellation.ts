type OperationContext = {id:string; db:D1Database};
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
function guardedDatabase(db:D1Database,id:string):D1Database {
 const originals=new WeakMap<object,D1PreparedStatement>();
 const mutations=new WeakMap<object,boolean>();
 // Accounting is retained even if the user stops a call that was already sent.
 const guarded=(sql:string)=>!/^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql)&&!/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE)\s+(?:ai_calls|ai_daily)\b/i.test(sql);
 const execute=async(statements:D1PreparedStatement[])=>{
  const needsFence=statements.some(s=>mutations.get(s)!==false);
  const raw=statements.map(s=>originals.get(s)||s);
  if(!needsFence)return db.batch(raw);
  const results=await db.batch([db.prepare('INSERT OR REPLACE INTO ai_operation_fences(operation_id) VALUES(?)').bind(id),...raw]);
  return results.slice(1);
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
   // Avoid introducing an unguarded write path in a scoped operation.
   if(key==='exec'||key==='withSession')return ()=>{throw new Error('Use prepared statements inside an AI operation');};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }
 });
}
export function scopeAIOperation(env:Env,id:string):Env {
 const scoped={...env,DB:guardedDatabase(env.DB,id)};
 contexts.set(scoped,{id,db:env.DB});return scoped;
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
 const guardedFetch:typeof fetch=(input,init)=>fetcher(input,{...init,signal:AbortSignal.any([controller.signal,...(init?.signal?[init.signal]:[])])});
 try{
  const result=await execute(guardedFetch);
  await assertOperationActive(context); // Also covers providers / test doubles ignoring AbortSignal.
  return result;
 }catch(e){await assertOperationActive(context);throw e;}
 finally{disposed=true;clearTimeout(timer);}
}
