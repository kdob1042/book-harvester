import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {scopeAIOperation,cancellableAI,AIOperationCanceled} from '../src/ai-cancellation.ts';
import {withAIOperations} from '../src/ai-operation-worker.ts';
import {describeAIAction} from '../public/ai-action-contract.js';

function database(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 db.exec(`CREATE TABLE book_operation_receipts(operation_key TEXT PRIMARY KEY,state TEXT);
 CREATE TABLE discovery_runs(id TEXT PRIMARY KEY,state TEXT,error TEXT);
 CREATE TABLE integration_runs(id TEXT PRIMARY KEY,state TEXT,error TEXT,request_key TEXT,result_json TEXT);
 CREATE TABLE integration_proposal_runs(id TEXT PRIMARY KEY,state TEXT,error TEXT);
 CREATE TABLE integration_proposals(id TEXT PRIMARY KEY,state TEXT,error TEXT,attempt INTEGER,result_json TEXT);
 CREATE TABLE saved_results(id TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE ai_calls(id TEXT,state TEXT);CREATE TABLE ai_daily(day TEXT PRIMARY KEY,calls INTEGER);
 CREATE TABLE captures(id TEXT PRIMARY KEY,version INTEGER,original_text TEXT);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,capture_id TEXT,version INTEGER,state TEXT,lease_token TEXT,created_at INTEGER);
 CREATE TABLE graph_jobs(id TEXT PRIMARY KEY,capture_id TEXT,version INTEGER,state TEXT,lease_token TEXT,created_at INTEGER);
 CREATE TABLE theme_jobs(id TEXT PRIMARY KEY,kind TEXT,target_id TEXT,version INTEGER,state TEXT,lease_token TEXT,created_at INTEGER);
 CREATE TABLE research_runs(id TEXT PRIMARY KEY,state TEXT,lease_token TEXT,created_at INTEGER);
 CREATE TABLE import_jobs(id TEXT PRIMARY KEY,state TEXT,lease_token TEXT,created_at INTEGER);
 CREATE TABLE embedding_jobs(capture_id TEXT PRIMARY KEY,version INTEGER,state TEXT,lease_token TEXT);
 CREATE TABLE bibliography_jobs(capture_id TEXT PRIMARY KEY,version INTEGER,state TEXT,lease_token TEXT);
 CREATE TABLE reflection_jobs(id TEXT PRIMARY KEY,signature TEXT,input_json TEXT,state TEXT,lease_token TEXT,created_at INTEGER);
 CREATE TABLE import_items(job_id TEXT,capture_id TEXT);CREATE TABLE research_materials(run_id TEXT,capture_id TEXT);
 CREATE TABLE theme_memberships(theme_id TEXT,capture_id TEXT,capture_version INTEGER);
 CREATE TABLE explicit_ai_actions(kind TEXT,target_id TEXT,version INTEGER);`);
 db.exec(readFileSync(new URL('../migrations/0020_ai_operations.sql',import.meta.url),'utf8'));
 class Statement{
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){return new Statement(this.sql,values);}
  exec(){const results=db.prepare(this.sql).all(...this.values);return {success:true,results,meta:{changes:db.prepare('SELECT changes() AS n').get().n}};}
  async all(){return this.exec();}async run(){return this.exec();}async first(column){const row=this.exec().results[0]||null;return column?row?.[column]??null:row;}
 }
 const binding={prepare:sql=>new Statement(sql),async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.exec());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}};
 return {db,binding};
}
const operation=(db,id,mode='inline')=>db.prepare("INSERT INTO ai_operations(id,path,label,mode,state,created_at,updated_at) VALUES(?,?,?,?,'running',?,?)").run(id,'/api/themes/t/drilldown','深掘り',mode,Date.now(),Date.now());
const markCanceled=(db,id)=>db.prepare("UPDATE ai_operations SET state='canceled' WHERE id=?").run(id);
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition did not become true');};

test('one route contract covers AI launches without treating manual saves as new AI requests',()=>{
 for(const path of ['/api/themes/t/drilldown','/api/themes/t/relationships','/api/book/discover','/api/book/integrate','/api/themes/t/rebuild','/api/research','/api/captures/c/ask'])assert.ok(describeAIAction(path,'POST'),path);
 for(const path of ['/api/themes/t/drilldown/save','/api/themes/t/drilldown/candidates','/api/themes/t/relationships/save','/api/themes/t/relationships/remove','/api/research/r/cancel'])assert.equal(describeAIAction(path,'POST'),null,path);
 assert.equal(describeAIAction('/api/state','GET'),null);
});
test('cancellation fences individual writes and entire result batches without touching previous results',async t=>{
 const {db,binding}=database();t.after(()=>db.close());const id=crypto.randomUUID();operation(db,id);const env=scopeAIOperation({DB:binding},id);
 await env.DB.prepare('INSERT INTO saved_results VALUES(?,?)').bind('old','preserved').run();
 markCanceled(db,id);
 await assert.rejects(env.DB.prepare('INSERT INTO saved_results VALUES(?,?)').bind('late','rejected').run(),/ai_operation_not_active/);
 await assert.rejects(env.DB.batch([env.DB.prepare("UPDATE saved_results SET value='changed' WHERE id='old'"),env.DB.prepare("INSERT INTO saved_results VALUES('late','rejected')")]),/ai_operation_not_active/);
 assert.deepEqual({...db.prepare('SELECT * FROM saved_results').get()},{id:'old',value:'preserved'});
 await env.DB.prepare("INSERT INTO ai_calls VALUES('attempt','failed')").run();assert.equal(db.prepare('SELECT count(*) AS n FROM ai_calls').get().n,1);
});
test('mutation RETURNING retains the first() contract and cancellation is scoped to one operation',async t=>{
 const {db,binding}=database();t.after(()=>db.close());const a=crypto.randomUUID(),b=crypto.randomUUID();operation(db,a);operation(db,b);markCanceled(db,a);
 const env=scopeAIOperation({DB:binding},b);
 assert.equal(await env.DB.prepare("INSERT INTO saved_results VALUES('b','kept') RETURNING id").first('id'),'b');
});
test('late provider output is rejected even when the provider ignores AbortSignal',async t=>{
 const {db,binding}=database();t.after(()=>db.close());const id=crypto.randomUUID();operation(db,id);const env=scopeAIOperation({DB:binding},id);
 let release;const gate=new Promise(resolve=>{release=resolve;});let entered=false;
 const work=cancellableAI(env,async()=>{entered=true;await gate;return Response.json({answer:'late'});},async fetcher=>(await fetcher('https://provider.invalid')).json());
 await waitFor(()=>entered);markCanceled(db,id);release();await assert.rejects(work,AIOperationCanceled);
});
test('a provider request receives an abort signal after durable cancellation',async t=>{
 const {db,binding}=database();t.after(()=>db.close());const id=crypto.randomUUID();operation(db,id);const env=scopeAIOperation({DB:binding},id);let entered=false,aborted=false;
 const work=cancellableAI(env,async(_url,init)=>{entered=true;await new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(init.signal.reason);},{once:true}));},fetcher=>fetcher('https://provider.invalid'));
 await waitFor(()=>entered);markCanceled(db,id);await assert.rejects(work,AIOperationCanceled);assert.equal(aborted,true);
});
function appFixture(t){
 const {db,binding}=database();t.after(()=>db.close());const sent=[],pending=[],gates=new Map();let providerCalls=0;
 const env={DB:binding,APP_ORIGIN:'https://book.test',AI_EXECUTION_POLICY:'automatic_legacy',HARVEST_QUEUE:{async send(body){sent.push(body);}}};
 const ctx={waitUntil(p){pending.push(p);}};
 const fake={
  async fetch(request,scoped,context){
   if(request.headers.get('cookie')!=='owner=yes')return Response.json({error:'Unauthorized'},{status:401});
   const path=new URL(request.url).pathname;
   if(path==='/api/ai-activity')return Response.json({active:false},{headers:{'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
   if(path==='/api/captures'){
    const body=await request.json();await scoped.DB.prepare('INSERT OR IGNORE INTO captures VALUES(?,1,?)').bind(body.id,body.text).run();
    await scoped.DB.prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,1,'pending',NULL,?)").bind(body.job_id,body.id,Date.now()).run();
    context.waitUntil(scoped.HARVEST_QUEUE.send({job_id:body.job_id}));return Response.json({id:body.id,version:1},{status:201});
   }
   const id=request.headers.get('x-ai-operation-id');
   await cancellableAI(scoped,async()=>{providerCalls++;await gates.get(id);return Response.json({text:'result'});},async fetcher=>{await (await fetcher('https://provider.invalid')).json();});
   await scoped.DB.prepare('INSERT INTO saved_results VALUES(?,?)').bind(id,'result').run();return Response.json({ok:true});
  },
  async queue(batch,scoped){for(const message of batch.messages){const job=await scoped.DB.prepare("SELECT * FROM jobs WHERE id=? AND state='pending'").bind(message.body.job_id).first();if(job){await scoped.DB.prepare("INSERT INTO saved_results VALUES(?,'queue result')").bind(job.id).run();await scoped.DB.prepare("UPDATE jobs SET state='completed' WHERE id=?").bind(job.id).run();}message.ack();}},
  async scheduled(){}
 };
 const worker=withAIOperations(fake);
 async function request(path,{id,method='GET',body,auth=true,origin=env.APP_ORIGIN}={}){
  return worker.fetch(new Request(`${env.APP_ORIGIN}${path}`,{method,headers:{...(auth?{cookie:'owner=yes'}:{}),...(id?{'x-ai-operation-id':id}:{}),...(method!=='GET'?{origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env,ctx);
 }
 return {db,env,worker,request,sent,gates,get providerCalls(){return providerCalls;},async settle(){while(pending.length)await Promise.all(pending.splice(0));}};
}
test('stop-before-start is durable; completed work wins a later stop without claiming it was canceled',async t=>{
 const f=appFixture(t),stopped=crypto.randomUUID();
 assert.equal((await (await f.request(`/api/ai-operations/${stopped}/cancel`,{method:'POST'})).json()).state,'canceled');
 const response=await f.request('/api/themes/t/drilldown',{id:stopped,method:'POST',body:{}});assert.equal(response.status,200);assert.equal((await response.json()).canceled,true);assert.equal(f.providerCalls,0);
 const completed=crypto.randomUUID();assert.equal((await f.request('/api/themes/t/drilldown',{id:completed,method:'POST',body:{}})).status,200);
 assert.equal((await (await f.request(`/api/ai-operations/${completed}/cancel`,{method:'POST'})).json()).state,'completed');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM saved_results').get().n,1);
});
test('canceling one in-flight request never cancels a different request',async t=>{
 const f=appFixture(t),a=crypto.randomUUID(),b=crypto.randomUUID();let releaseA,releaseB;
 f.gates.set(a,new Promise(r=>{releaseA=r;}));f.gates.set(b,new Promise(r=>{releaseB=r;}));
 const pa=f.request('/api/themes/a/drilldown',{id:a,method:'POST',body:{}}),pb=f.request('/api/themes/b/drilldown',{id:b,method:'POST',body:{}});
 await waitFor(()=>f.providerCalls===2);await f.request(`/api/ai-operations/${a}/cancel`,{method:'POST'});releaseA();releaseB();
 assert.equal((await (await pa).json()).canceled,true);assert.equal((await pb).status,200);assert.deepEqual(f.db.prepare('SELECT id FROM saved_results').all().map(r=>r.id),[b]);
});
test('ingestion preserves the original, and an early cancellation prevents queued AI work',async t=>{
 const f=appFixture(t),id=crypto.randomUUID(),capture=crypto.randomUUID(),job=crypto.randomUUID();
 await f.request(`/api/ai-operations/${id}/cancel`,{method:'POST'});
 const response=await f.request('/api/captures',{id,method:'POST',body:{id:capture,job_id:job,text:'keep my original'}});assert.equal(response.status,201);
 assert.equal(f.db.prepare('SELECT original_text FROM captures').get().original_text,'keep my original');assert.equal(f.db.prepare('SELECT state FROM jobs').get().state,'canceled');
 await f.settle();let ack=false;await f.worker.queue({queue:'test',messages:[{body:{job_id:job},ack(){ack=true;},retry(){throw Error('must not retry canceled work');}}]},f.env);
 assert.equal(ack,true);assert.equal(f.db.prepare('SELECT count(*) AS n FROM saved_results').get().n,0);
});
test('cancellation cannot affect a newer job generation; control APIs require authentication and same origin',async t=>{
 const f=appFixture(t),id=crypto.randomUUID(),capture=crypto.randomUUID(),job=crypto.randomUUID();
 await f.request('/api/captures',{id,method:'POST',body:{id:capture,job_id:job,text:'keep'}});await f.settle();
 f.db.prepare("UPDATE jobs SET version=2,state='pending' WHERE id=?").run(job);
 assert.equal((await f.request(`/api/ai-operations/${id}/cancel`,{method:'POST',auth:false})).status,401);
 assert.equal((await f.request(`/api/ai-operations/${id}/cancel`,{method:'POST',origin:'https://evil.test'})).status,403);
 await f.request(`/api/ai-operations/${id}/cancel`,{method:'POST'});assert.equal(f.db.prepare('SELECT state FROM jobs').get().state,'pending');
 assert.equal((await f.request('/api/ai-operations',{auth:false})).status,401);
});

test('status polling cannot finish an operation while its queue delivery is scheduling a next stage',async t=>{
 const {beginOperationLease,endOperationLease,operationSnapshot}=await import('../src/ai-operation-jobs.ts');
 const {db,binding}=database();t.after(()=>db.close());const id=crypto.randomUUID();operation(db,id,'ingestion');const env={DB:binding,AI_EXECUTION_POLICY:'automatic_legacy'};
 db.prepare("INSERT INTO jobs VALUES('root','capture',1,'completed',NULL,1)").run();db.prepare("INSERT INTO ai_operation_jobs VALUES('capture','root','1',?)").run(id);
 const lease=await beginOperationLease(env,id);assert.equal((await operationSnapshot(env,id)).state,'queued');
 db.prepare("INSERT INTO graph_jobs VALUES('child','capture',1,'pending',NULL,1)").run();db.prepare("INSERT INTO ai_operation_jobs VALUES('graph','child','1',?)").run(id);
 await endOperationLease(env,lease);assert.equal((await operationSnapshot(env,id)).state,'queued');
 db.prepare("UPDATE graph_jobs SET state='completed' WHERE id='child'").run();assert.equal((await operationSnapshot(env,id)).state,'completed');
});
