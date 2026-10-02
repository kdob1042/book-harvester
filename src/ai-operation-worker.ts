import {describeAIAction} from '../public/ai-action-contract.js';
import {scopeAIOperation} from './ai-cancellation.ts';
import {beginOperationLease,endOperationLease,getOperation,attachRootJob,attachChildJobs,cancelOperationJobs,operationForMessage,operationSnapshot,finishQueuedRegistration,type Operation} from './ai-operation-jobs.ts';
const validId=(id:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
type AppWorker={fetch:(request:Request,env:Env,ctx:ExecutionContext)=>Promise<Response>;queue:(batch:MessageBatch<unknown>,env:Env)=>Promise<void>;scheduled:(event:ScheduledController,env:Env)=>Promise<void>};
// Buffer queue publication until the initiating request's job ownership is durable.
// Unrelated jobs found by the shared dispatcher are still sent without adopting them.
function bufferQueue(env:Env){
 const pending:{body:unknown;options?:QueueSendOptions}[]=[];
 const queue=new Proxy(env.HARVEST_QUEUE,{
  get(target,key){
   if(key==='send')return async(body:unknown,options?:QueueSendOptions)=>{pending.push({body,options});};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }
 });
 return {env:{...env,HARVEST_QUEUE:queue},async flush(){for(const entry of pending)await env.HARVEST_QUEUE.send(entry.body as never,entry.options);}};
}
const reply=(data:unknown,status:number,headers:HeadersInit)=>Response.json(data,{status,headers});
export function withAIOperations(app:AppWorker){
 return {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
   const path=new URL(request.url).pathname,control=/^\/api\/ai-operations(?:\/([^/]+)(?:\/(cancel))?)?$/.exec(path),spec=describeAIAction(path,request.method),id=request.headers.get('x-ai-operation-id')||'';
   if(path==='/api/state'&&request.method==='GET'){
    const response=await app.fetch(request,env,ctx);if(!response.ok)return response;
    return reply({...await response.json<Record<string,unknown>>(),automatic_ingestion_ai:env.AI_EXECUTION_POLICY==='automatic_legacy'},response.status,response.headers);
   }
   if(!control&&(!spec||!id||spec.mode==='ingestion'&&env.AI_EXECUTION_POLICY!=='automatic_legacy'))return app.fetch(request,env,ctx);
   // Reuse the application's own authentication checks and security headers.
   const gate=await app.fetch(new Request(new URL('/api/ai-activity',request.url),{headers:request.headers}),env,ctx);
   if(!gate.ok)return gate;
   const headers=new Headers(gate.headers);headers.delete('Content-Length');headers.set('Cache-Control','no-store');
   if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==env.APP_ORIGIN)return reply({error:'この画面から操作し直してください。'},403,headers);
   if(control){
    const key=control[1];
    if(key&&!validId(key))return reply({error:'処理IDが不正です。'},400,headers);
    if(control[2]==='cancel'&&request.method==='POST'){
     const time=Date.now();
     // Stop-before-start is a tombstone, not a no-op; a later start must observe it.
     await env.DB.prepare("INSERT INTO ai_operations(id,path,label,mode,state,created_at,updated_at) VALUES(?,'','','inline','canceled',?,?) ON CONFLICT(id) DO UPDATE SET state='canceled',updated_at=excluded.updated_at WHERE state IN ('running','queued')").bind(key,time,time).run();
     const op=await getOperation(env,key);
     if(op?.state==='canceled')await cancelOperationJobs(env,key);
     return reply(await operationSnapshot(env,key),200,headers);
    }
    if(request.method==='GET'&&key){const value=await operationSnapshot(env,key);return reply(value||{state:'not_found'},200,headers);}
    if(request.method==='GET'&&!key){
     const active=await env.DB.prepare("SELECT id FROM ai_operations WHERE state IN ('running','queued') ORDER BY created_at DESC LIMIT 20").all<{id:string}>();
     return reply({operations:await Promise.all(active.results.map(o=>operationSnapshot(env,o.id)))},200,headers);
    }
    return reply({error:'この操作は見つかりません。'},404,headers);
   }
   if(!validId(id))return reply({error:'処理IDが不正です。'},400,headers);
   const time=Date.now();
   let input:Record<string,any>={};if(path==='/api/graph/rebuild')try{input=await request.clone().json<Record<string,any>>();}catch{}
   await env.DB.prepare("INSERT OR IGNORE INTO ai_operations(id,path,label,mode,state,created_at,updated_at) VALUES(?,?,?,?,'running',?,?)").bind(id,path,spec!.label,spec!.mode,time,time).run();
   const existing=(await getOperation(env,id))!;
   if(existing.path&&existing.path!==path)return reply({error:'処理IDが別の操作に使われています。'},409,headers);
   if(existing.state==='canceled'&&spec!.mode!=='ingestion')return reply({error:'AI処理を停止しました。',canceled:true,ai_operation:await operationSnapshot(env,id)},200,headers);
   // Original ingestion is never canceled halfway through durable storage. Only its AI jobs are stopped.
   const lease=await beginOperationLease(env,id),buffered=bufferQueue(env),pending:Promise<unknown>[]=[];
   const context=new Proxy(ctx,{get(target,key){if(key==='waitUntil')return (p:Promise<unknown>)=>{pending.push(p);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
   const operationEnv=spec!.mode==='inline'?scopeAIOperation(buffered.env,id):buffered.env;
   let response:Response;
   try{
    const extracting=/^\/api\/(captures|imports)\/([a-f0-9-]{36})\/(extract|retry)$/.exec(path);
    if(extracting&&request.method==='POST'){
     if(extracting[1]==='captures')await env.DB.prepare("UPDATE jobs SET state='blocked',error_code='extraction_required' WHERE capture_id=? AND state='canceled'").bind(extracting[2]).run();
     else await env.DB.prepare("UPDATE import_jobs SET state='ready',error_code='extraction_required' WHERE id=? AND state='canceled'").bind(extracting[2]).run();
    }
    response=await app.fetch(request,operationEnv,context);
    while(pending.length)await Promise.allSettled(pending.splice(0));
    const data=await response.clone().json<Record<string,any>>();
    if(response.ok&&spec!.mode!=='inline'){
     const op={...existing,id,path,mode:spec!.mode} as Operation;
     await attachRootJob(env,op,path,data,input);await attachChildJobs(env,id);await finishQueuedRegistration(env,id);
    }else await env.DB.prepare("UPDATE ai_operations SET state=?,updated_at=? WHERE id=? AND state IN ('running','queued')").bind(response.ok?'completed':'failed',Date.now(),id).run();
    const snapshot=await operationSnapshot(env,id);
    if(snapshot?.state==='canceled'&&spec!.mode!=='ingestion')return reply({error:'AI処理を停止しました。',canceled:true,ai_operation:snapshot},200,headers);
    return reply({...data,ai_operation:snapshot},response.status,response.headers);
   }catch(e){
    const op=await getOperation(env,id);
    if(op?.state==='canceled'){await cancelOperationJobs(env,id);return reply({error:'AI処理を停止しました。',canceled:true,ai_operation:await operationSnapshot(env,id)},200,headers);}
    await env.DB.prepare("UPDATE ai_operations SET state='failed',updated_at=? WHERE id=? AND state IN ('running','queued')").bind(Date.now(),id).run();
    return reply({error:'処理を完了できませんでした。保存済みの資料は残っています。',ai_operation:await operationSnapshot(env,id)},500,headers);
   }finally{await endOperationLease(env,lease);ctx.waitUntil(buffered.flush());}
  },
  async queue(batch:MessageBatch<unknown>,env:Env){
   for(const message of batch.messages){
    const op=await operationForMessage(env,message.body);
    if(!op){await app.queue({...batch,messages:[message],ackAll:()=>message.ack(),retryAll:options=>message.retry(options)},env);continue;}
    if(op.state==='canceled'){await cancelOperationJobs(env,op.id);message.ack();continue;}
    const lease=await beginOperationLease(env,op.id),buffered=bufferQueue(env);let retried=false,retryOptions:QueueRetryOptions|undefined;
    const wrappedMessage=new Proxy(message,{get(target,key){if(key==='ack')return ()=>{};if(key==='retry')return (options?:QueueRetryOptions)=>{retried=true;retryOptions=options;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    try{
     await app.queue({...batch,messages:[wrappedMessage],ackAll:()=>{},retryAll:options=>{retried=true;retryOptions=options;}},scopeAIOperation(buffered.env,op.id));
     await attachChildJobs(env,op.id);
     const fresh=await getOperation(env,op.id);
     if(fresh?.state==='canceled'){await cancelOperationJobs(env,op.id);retried=false;}
     else await operationSnapshot(env,op.id);
     await buffered.flush();
     if(retried)message.retry(retryOptions);else message.ack();
    }catch{if((await getOperation(env,op.id))?.state==='canceled'){await cancelOperationJobs(env,op.id);message.ack();}else message.retry({delaySeconds:60});}
    finally{await endOperationLease(env,lease);await operationSnapshot(env,op.id);}
   }
  },
  async scheduled(event:ScheduledController,env:Env){
   await app.scheduled(event,env);
   await env.DB.prepare("DELETE FROM ai_operations WHERE state IN ('completed','failed','canceled') AND updated_at<?").bind(Date.now()-7*86400000).run();
  }
 };
}
