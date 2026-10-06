import {digest} from './core.ts';
import {describeAIAction} from '../public/ai-action-contract.js';
import {scopeAIOperation,scopeOriginalIngestion} from './ai-cancellation.ts';
import {beginOperationLease,endOperationLease,getOperation,claimExistingRoot,attachRootJob,attachChildJobs,cancelOperationJobs,operationForMessage,operationSnapshot,finishQueuedRegistration,type Operation} from './ai-operation-jobs.ts';
const validId=(id:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const active=(state:string)=>['running','queued'].includes(state);
type AppWorker={fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>;queue(batch:MessageBatch<unknown>,env:Env):Promise<void>;scheduled(event:ScheduledController,env:Env):Promise<void>};
// Publish only after ownership is durable. Child jobs also inherit ownership in
// the same D1 transaction that creates them, protecting concurrent cron sends.
function bufferQueue(env:Env){
 const pending:{body:unknown;options?:QueueSendOptions}[]=[];
 const queue=new Proxy(env.HARVEST_QUEUE,{get(target,key){
  if(key==='send')return async(body:unknown,options?:QueueSendOptions)=>{pending.push({body,options});};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 return {env:{...env,HARVEST_QUEUE:queue},async flush(){for(const entry of pending)await env.HARVEST_QUEUE.send(entry.body as never,entry.options);}};
}
const reply=(data:unknown,status:number,headers:HeadersInit)=>Response.json(data,{status,headers});
const stopped=async(env:Env,id:string,headers:HeadersInit)=>reply({error:'AI処理を停止しました。',canceled:true,ai_operation:await operationSnapshot(env,id)},200,headers);
async function replay(env:Env,op:Operation,headers:HeadersInit){
 if(op.state==='canceled')return stopped(env,op.id,headers);
 return reply({...op.response_json?JSON.parse(op.response_json):{},duplicate:true,ai_operation:await operationSnapshot(env,op.id)},op.response_status||202,headers);
}
async function operationRequestIdentity(env:Env,path:string,input:Record<string,any>,mode:string){
 if(path==='/api/graph/rebuild'&&Array.isArray(input.capture_ids)){
  const ids=[...new Set(input.capture_ids.filter((v:unknown)=>typeof v==='string'))].sort();
  const captures=await env.DB.prepare('SELECT id,version FROM captures WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(JSON.stringify(ids)).all<{id:string;version:number}>();
  const identity=JSON.stringify({ids,versions:captures.results});return {key:`${path}:${identity}`,hash:await digest(identity)};
 }
 const theme=/^\/api\/themes\/([^/]+)\/rebuild$/.exec(path);
 if(theme){const identity=JSON.stringify({path:decodeURIComponent(path),version:input.version});return {key:`rebuild:${identity}`,hash:await digest(identity)};}
 if(mode!=='inline')return null;
 const key=typeof input.idempotency_key==='string'?`${path}:${input.idempotency_key}`:path==='/api/book/integration-proposals/execute'&&Array.isArray(input.selected_ids)?`${path}:${input.run_id}:${[...input.selected_ids].sort().join(',')}`:null;
 return key?{key,hash:await digest(JSON.stringify(input))}:null;
}
export function withAIOperations(app:AppWorker){
 return {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
   const path=new URL(request.url).pathname,control=/^\/api\/ai-operations(?:\/([^/]+)(?:\/(cancel))?)?$/.exec(path),spec=describeAIAction(path,request.method),id=request.headers.get('x-ai-operation-id')||'';
   if(path==='/api/state'&&request.method==='GET'){
    const response=await app.fetch(request,env,ctx);if(!response.ok)return response;
    return reply({...await response.json<Record<string,unknown>>(),automatic_ingestion_ai:env.AI_EXECUTION_POLICY==='automatic_legacy'},response.status,response.headers);
   }
   if(!control&&(!spec||!id||spec.mode==='ingestion'&&env.AI_EXECUTION_POLICY!=='automatic_legacy'))return app.fetch(request,env,ctx);
   const gate=await app.fetch(new Request(new URL('/api/ai-activity',request.url),{headers:request.headers}),env,ctx);
   if(!gate.ok)return gate;
   const headers=new Headers(gate.headers);headers.delete('Content-Length');headers.set('Cache-Control','no-store');
   if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==env.APP_ORIGIN)return reply({error:'この画面から操作し直してください。'},403,headers);
   if(control){
    const key=control[1];if(key&&!validId(key))return reply({error:'処理IDが不正です。'},400,headers);
    if(control[2]==='cancel'&&request.method==='POST'){
     // Reconcile already-finished queued work first. Final inline result commits
     // atomically finish their operation, so a late stop cannot undo that result.
     await operationSnapshot(env,key);
     const time=Date.now();
     await env.DB.prepare("INSERT INTO ai_operations(id,path,label,mode,state,created_at,updated_at) VALUES(?,'','','inline','canceled',?,?) ON CONFLICT(id) DO UPDATE SET state='canceled',updated_at=excluded.updated_at WHERE state IN ('running','queued')").bind(key,time,time).run();
     if((await getOperation(env,key))?.state==='canceled')await cancelOperationJobs(env,key);
     return reply(await operationSnapshot(env,key),200,headers);
    }
    if(request.method==='GET'&&key)return reply(await operationSnapshot(env,key)||{state:'not_found'},200,headers);
    if(request.method==='GET'&&!key){
     const rows=await env.DB.prepare("SELECT id FROM ai_operations WHERE state IN ('running','queued') ORDER BY created_at DESC LIMIT 20").all<{id:string}>();
     return reply({operations:await Promise.all(rows.results.map(o=>operationSnapshot(env,o.id)))},200,headers);
    }
    return reply({error:'この操作は見つかりません。'},404,headers);
   }
   if(!validId(id))return reply({error:'処理IDが不正です。'},400,headers);
   let input:Record<string,any>={};try{input=await request.clone().json<Record<string,any>>();}catch{}
   const workflow=request.headers.get('x-ai-operation-workflow'),extract=/^\/api\/captures\/([^/]+)\/extract$/.exec(path);
   if(workflow&&(workflow!=='text-discovery'||!extract&&path!=='/api/book/discover'))return reply({error:'処理の組み合わせが不正です。'},400,headers);
   const time=Date.now(),created=await env.DB.prepare("INSERT OR IGNORE INTO ai_operations(id,path,label,mode,state,created_at,updated_at,workflow,target_id,stage) VALUES(?,?,?,?,'running',?,?,?,?,?)")
    .bind(id,path,workflow?'抽出・関連の探索':spec!.label,spec!.mode,time,time,workflow,workflow?(extract?.[1]||String(input.id)):null,workflow?(extract?'extracting':'discovering'):null).run();
   let op=(await getOperation(env,id))!;
   const continuation=!created.meta.changes&&workflow==='text-discovery'&&op.workflow===workflow&&path==='/api/book/discover'&&op.target_id===String(input.id)&&op.stage==='extracting';
   if(op.path&&op.path!==path&&!continuation)return reply({error:'処理IDが別の操作に使われています。'},409,headers);
   if(created.meta.changes||op.state==='canceled'){
    const identity=await operationRequestIdentity(env,path,input,spec!.mode);
    if(identity){
     const {key,hash}=identity;
     await env.DB.prepare(`INSERT INTO ai_operation_requests VALUES(?,?,?) ON CONFLICT(request_key) DO UPDATE SET operation_id=excluded.operation_id,request_hash=excluded.request_hash
      WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_requests.operation_id AND state IN ('completed','failed','canceled'))`).bind(key,hash,id).run();
     const owner=await env.DB.prepare('SELECT o.*,r.request_hash FROM ai_operation_requests r JOIN ai_operations o ON o.id=r.operation_id WHERE r.request_key=?').bind(key).first<Operation&{request_hash:string}>();
     if(owner&&owner.id!==id){
      await env.DB.prepare("UPDATE ai_operations SET state='failed',updated_at=? WHERE id=? AND state IN ('running','queued')").bind(Date.now(),id).run();
      if(owner.request_hash!==hash)return reply({error:'同じ操作の内容が異なります。'},409,headers);
      return reply({duplicate:true,ai_operation:await operationSnapshot(env,owner.id)},202,headers);
     }
    }
   }
   // Claim before the extraction route can dispatch. Simultaneous tabs see the
   // same canonical owner; no OR REPLACE can detach the original Stop button.
   if(created.meta.changes||op.state==='canceled'){
    const owner=await claimExistingRoot(env,op,path,input);
    if(owner&&owner.id!==id&&active(owner.state)){
     await env.DB.prepare("UPDATE ai_operations SET state='failed',updated_at=? WHERE id=? AND state IN ('running','queued')").bind(Date.now(),id).run();
     if(workflow||path==='/api/graph/rebuild')return reply({error:'別の操作がこの資料を処理中です。完了後に実行してください。',error_code:'operation_owned_by_another_request',ai_operation:await operationSnapshot(env,id)},409,headers);
     return reply({duplicate:true,ai_operation:await operationSnapshot(env,owner.id)},202,headers);
    }
   }

   if(op.state==='canceled'&&spec!.mode!=='ingestion'){await cancelOperationJobs(env,id);return stopped(env,id,headers);}
   if(!created.meta.changes&&op.path){
    if(continuation&&active(op.state)){
     const claimed=await env.DB.prepare(`UPDATE ai_operations SET stage='discovering',mode='inline',path=?,updated_at=? WHERE id=? AND stage='extracting' AND state IN ('running','queued')
      AND EXISTS(SELECT 1 FROM harvests h JOIN captures c ON c.id=h.capture_id AND c.version=h.version WHERE c.id=? AND c.version=?)
      AND NOT EXISTS(SELECT 1 FROM ai_operation_leases WHERE operation_id=? AND expires_at>?)`).bind(path,Date.now(),id,String(input.id),Number(input.version),id,Date.now()).run();
     if(!claimed.meta.changes){op=(await getOperation(env,id))!;if(op.state==='canceled')return stopped(env,id,headers);return reply({error:'抽出が完了していないか、この処理はすでに開始されています。',ai_operation:await operationSnapshot(env,id)},409,headers);}
     op=(await getOperation(env,id))!;
    }else return replay(env,op,headers);
   }
   const lease=await beginOperationLease(env,id),buffered=bufferQueue(env),pending:Promise<unknown>[]=[];
   const context=new Proxy(ctx,{get(target,key){if(key==='waitUntil')return (p:Promise<unknown>)=>{pending.push(p);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
   // Original user material must survive an early stop. All explicit AI routes,
   // including queued registration, are fenced against cancellation.
   const operationEnv=spec!.mode==='ingestion'?scopeOriginalIngestion(buffered.env,id):scopeAIOperation(buffered.env,id,spec!.mode==='inline');
   try{
    const extracting=/^\/api\/(captures|imports|research)\/([a-f0-9-]{36})\/(extract|retry)$/.exec(path);
    if(extracting&&request.method==='POST'){
     if(extracting[1]==='captures')await operationEnv.DB.prepare("UPDATE jobs SET state='blocked',error_code='extraction_required' WHERE capture_id=? AND state='canceled'").bind(extracting[2]).run();
     else if(extracting[1]==='imports')await operationEnv.DB.prepare("UPDATE import_jobs SET state='ready',error_code='extraction_required' WHERE id=? AND state='canceled'").bind(extracting[2]).run();
     else await operationEnv.DB.prepare("UPDATE research_runs SET state='failed',error_code='ai_operation_canceled' WHERE id=? AND state='canceled'").bind(extracting[2]).run();
    }
    const response=await app.fetch(request,operationEnv,context);
    while(pending.length)await Promise.allSettled(pending.splice(0));
    const data=await response.clone().json<Record<string,any>>();
    if(response.ok&&spec!.mode!=='inline'){
     await attachRootJob(env,op,path,data,input);await attachChildJobs(env,id);await finishQueuedRegistration(env,id);
    }else await env.DB.prepare("UPDATE ai_operations SET state=?,updated_at=? WHERE id=? AND state IN ('running','queued')").bind(!response.ok||['failed','blocked'].includes(data.state)||Array.isArray(data.proposals)&&data.proposals.some((p:Record<string,unknown>)=>['failed','running'].includes(String(p.state)))?'failed':['running','pending','queued'].includes(data.state)||Array.isArray(data.proposals)&&data.proposals.some((p:Record<string,unknown>)=>p.state==='running')?'queued':'completed',Date.now(),id).run();
    await env.DB.prepare('UPDATE ai_operations SET response_json=?,response_status=? WHERE id=?').bind(JSON.stringify(data),response.status,id).run();
    const snapshot=await operationSnapshot(env,id);
    if(snapshot?.state==='canceled'&&spec!.mode!=='ingestion')return stopped(env,id,headers);
    return reply({...data,ai_operation:snapshot},response.status,response.headers);
   }catch(e){
    if((await getOperation(env,id))?.state==='canceled'){await cancelOperationJobs(env,id);return stopped(env,id,headers);}
    await env.DB.prepare("UPDATE ai_operations SET state='failed',updated_at=? WHERE id=? AND state IN ('running','queued')").bind(Date.now(),id).run();
    return reply({error:'処理を完了できませんでした。保存済みの資料は残っています。',ai_operation:await operationSnapshot(env,id)},500,headers);
   }finally{await endOperationLease(env,lease);ctx.waitUntil(buffered.flush());}
  },
  async queue(batch:MessageBatch<unknown>,env:Env){
   for(const message of batch.messages){
    const op=await operationForMessage(env,message.body);
    if(!op){await app.queue({...batch,messages:[message],ackAll:()=>message.ack(),retryAll:options=>message.retry(options)},env);continue;}
    if(!active(op.state)){if(op.state==='canceled')await cancelOperationJobs(env,op.id);message.ack();continue;}
    const lease=await beginOperationLease(env,op.id),buffered=bufferQueue(env);let retried=false,retryOptions:QueueRetryOptions|undefined;
    const wrappedMessage=new Proxy(message,{get(target,key){if(key==='ack')return ()=>{};if(key==='retry')return (options?:QueueRetryOptions)=>{retried=true;retryOptions=options;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    try{
     const completion=!op.workflow&&env.AI_EXECUTION_POLICY!=='automatic_legacy'?'queued':false;
     await app.queue({...batch,messages:[wrappedMessage],ackAll:()=>{},retryAll:options=>{retried=true;retryOptions=options;}},scopeAIOperation(buffered.env,op.id,completion));
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
   await env.DB.prepare('DELETE FROM ai_operation_leases WHERE expires_at<?').bind(Date.now()).run();
   // Keep terminal IDs/tombstones. Deleting them could resurrect a delayed start.
  }
 };
}
