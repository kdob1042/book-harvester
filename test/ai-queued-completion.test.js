import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json,mockAi,result,graphResponse,setProviderDouble,sentence} from './helpers.js';

function options(body,operationId){
 const value=json('POST',body);
 value.headers['x-ai-operation-id']=operationId;
 value.headers['Idempotency-Key']=crypto.randomUUID();
 return value;
}
async function setup(t){
 const f=await fixture({policy:'explicit'});
 t.after(f.close);t.after(()=>setProviderDouble(null));
 await f.login();setProviderDouble(mockAi);return f;
}
function seedCapture(f,{harvest=true}={}){
 const id=crypto.randomUUID();
 f.db.prepare("INSERT INTO captures(id,kind,original_text,note,version,created_at,updated_at,mutation_id,request_key,request_hash) VALUES(?,'text',?,'',1,0,0,?,?,'fixture')").run(id,sentence,id,id);
 if(harvest)f.db.prepare('INSERT INTO harvests(capture_id,version,result,created_at) VALUES(?,1,?,0)').run(id,JSON.stringify(result()));
 return id;
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
// Hold the actual D1 result transaction on either side of COMMIT, while the
// queue lease is still live. Status reconciliation cannot hide this race.
function pauseBatch(t,f,pattern,position='after'){
 const entered=deferred(),resume=deferred(),batch=f.env.DB.batch;let used=false;
 f.env.DB.batch=async statements=>{
  const matched=!used&&statements.some(s=>pattern.test(s.sql));
  if(matched){used=true;if(position==='before'){entered.resolve();await resume.promise;}}
  const results=await batch(statements);
  if(matched&&position==='after'){entered.resolve();await resume.promise;}
  return results;
 };
 t.after(()=>resume.resolve());
 return {async wait(delivery){await Promise.race([entered.promise,delivery.then(()=>{throw Error('result transaction was not reached');})]);},resume:resume.resolve};
}
async function deliver(f,body){
 assert.ok(body);let ack=0,retry=0;
 await f.worker.queue({queue:'queued-completion-regression',messages:[{body,ack(){ack++;},retry(){retry++;}}]},f.env);
 assert.equal(retry,0);assert.equal(ack,1);
}
const state=(f,op)=>f.db.prepare('SELECT state FROM ai_operations WHERE id=?').get(op).state;
async function cancel(f,op){const r=await f.request(`/api/ai-operations/${op}/cancel`,json('POST',{}));assert.equal(r.status,200);return r.json();}
async function rebuildGraph(f,captures){
 const op=crypto.randomUUID(),r=await f.request('/api/graph/rebuild',options({capture_ids:captures},op));
 assert.equal(r.status,202,await r.text());await f.settle();
 return {op,messages:f.messages.splice(0).filter(m=>m.graph_job_id)};
}
async function rebuildTheme(f){
 const op=crypto.randomUUID(),r=await f.request('/api/themes/theme%3Awork/rebuild',options({version:1,idempotency_key:crypto.randomUUID()},op));
 assert.equal(r.status,202);const data=await r.json();await f.settle();
 const jobId=data.data?.job_id||data.job_id;
 assert.ok(jobId,JSON.stringify(data));
 f.db.prepare('UPDATE theme_jobs SET available_at=0 WHERE id=?').run(jobId);
 return {op,body:{theme_job_id:jobId}};
}
function synthesis(input){return {changed:true,change_reason:'原文の成立条件を整理する。',understanding:input.claims.slice(0,1).map(c=>({id:'u1',text:'供給能力に条件がある。',interpretation:'ai',period:null,evidence:[{claim_id:c.id,quote:c.evidence.quote,role:'condition'}]})),changes:[],competing:[],conditions:[],questions:[],relations:[],theme_relations:[],view_proposal:null};}
function seedThemeMaterial(f){
 const capture=seedCapture(f);
 f.db.prepare("INSERT INTO theme_memberships VALUES('theme:work',?,1,?,'根拠','condition',?,'fixture',0)").run(capture,JSON.stringify([`${capture}:1:c1`]),capture);
 return capture;
}
async function research(f,{child=false}={}){
 const op=crypto.randomUUID(),r=await f.request('/api/research',options({question:'供給と価格の関係は？'},op));
 assert.equal(r.status,202);const {id}=await r.json();await f.settle();
 // Pre-retrieved synthetic material avoids any external network access.
 const capture=seedCapture(f),material=crypto.randomUUID(),url='https://www.boj.or.jp/fixture';
 f.db.prepare('UPDATE research_runs SET urls_json=? WHERE id=?').run(JSON.stringify([url]),id);
 f.db.prepare("INSERT INTO research_materials(id,run_id,url,title,body,state,capture_id,retrieved_at) VALUES(?,?,?,'一次資料',?,'saved',?,0)").run(material,id,url,sentence,capture);
 let childId=null;
 if(child){
  const childCapture=seedCapture(f,{harvest:false});childId=crypto.randomUUID();
  f.db.prepare('INSERT INTO jobs(id,capture_id,version,available_at,created_at,state,error_code) VALUES(?,?,1,0,0,?,?)').run(childId,childCapture,child==='dormant'?'blocked':'pending',child==='dormant'?'extraction_required':null);
  if(child!=='dormant')f.db.prepare("INSERT INTO explicit_ai_actions VALUES('extract',?,1,0)").run(childCapture);
  f.db.prepare("INSERT INTO ai_operation_jobs VALUES('capture',?,'1',?)").run(childId,op);
 }
 setProviderDouble(async(url,init)=>{
  const p=JSON.parse(init.body);
  if(p.text?.format?.name!=='external_research_v1')return mockAi(url,init);
  return graphResponse({},{summary:'原文に基づく検討',findings:[{text:'供給能力が価格に影響する。',stance:'qualifies',conditions:['供給不足の場合'],evidence:[{material_id:material,quote:sentence}],event_at:null,subject_period:null}],gaps:[],next_reading:[]});
 });
 return {op,id,childId,body:f.messages.splice(0).find(m=>m.research_id===id)};
}

test('single queued graph completion wins a stop after its result commit before delivery returns',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedCapture(f),{op,messages}=await rebuildGraph(f,[capture]);
 const gate=pauseBatch(t,f,/INSERT INTO graph_generations/),delivery=deliver(f,messages[0]);await gate.wait(delivery);
 assert.equal(f.db.prepare('SELECT count(*) n FROM graph_generations').get().n,1);
 assert.equal(state(f,op),'completed');assert.equal((await cancel(f,op)).state,'completed');
 gate.resume();await delivery;assert.equal(state(f,op),'completed');
});

test('queued graph cancellation wins before the final transaction and saves no generated result',{timeout:10000},async t=>{
 const f=await setup(t),{op,messages}=await rebuildGraph(f,[seedCapture(f)]);
 const gate=pauseBatch(t,f,/INSERT INTO graph_generations/,'before'),delivery=deliver(f,messages[0]);await gate.wait(delivery);
 assert.equal((await cancel(f,op)).state,'canceled');gate.resume();await delivery;
 assert.equal(f.db.prepare('SELECT count(*) n FROM graph_generations').get().n,0);
 assert.equal(f.db.prepare('SELECT state FROM graph_jobs').get().state,'canceled');
});

test('multi-graph root stays active after the first result and atomically completes only with the last',{timeout:10000},async t=>{
 const f=await setup(t),{op,messages}=await rebuildGraph(f,[seedCapture(f),seedCapture(f)]);
 assert.equal(messages.length,2);await deliver(f,messages[0]);
 assert.ok(['running','queued'].includes(state(f,op)));
 assert.equal(f.db.prepare("SELECT count(*) n FROM graph_jobs WHERE state='pending'").get().n,1);
 const gate=pauseBatch(t,f,/INSERT INTO graph_generations/),delivery=deliver(f,messages[1]);await gate.wait(delivery);
 assert.equal(state(f,op),'completed');assert.equal((await cancel(f,op)).state,'completed');
 gate.resume();await delivery;assert.equal(f.db.prepare('SELECT count(*) n FROM graph_generations').get().n,2);
});

test('stopping a multi-graph root between results preserves the first result and cancels the remaining job',{timeout:10000},async t=>{
 const f=await setup(t),{op,messages}=await rebuildGraph(f,[seedCapture(f),seedCapture(f)]);
 await deliver(f,messages[0]);assert.equal((await cancel(f,op)).state,'canceled');await deliver(f,messages[1]);
 assert.equal(f.db.prepare('SELECT count(*) n FROM graph_generations').get().n,1);
 assert.deepEqual(f.db.prepare('SELECT state FROM graph_jobs ORDER BY state').all().map(x=>x.state),['canceled','completed']);
});

test('theme synthesis result and queued completion are atomic against a late stop',{timeout:10000},async t=>{
 const f=await setup(t);seedThemeMaterial(f);const {op,body}=await rebuildTheme(f);
 setProviderDouble(async(_url,init)=>graphResponse({},synthesis(JSON.parse(JSON.parse(init.body).input))));
 const gate=pauseBatch(t,f,/INSERT INTO theme_revisions/),delivery=deliver(f,body);await gate.wait(delivery);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,1);
 assert.equal(state(f,op),'completed');assert.equal((await cancel(f,op)).state,'completed');gate.resume();await delivery;
});

test('theme synthesis stop before commit leaves no revision or synthesis pointer',{timeout:10000},async t=>{
 const f=await setup(t);seedThemeMaterial(f);const {op,body}=await rebuildTheme(f);
 setProviderDouble(async(_url,init)=>graphResponse({},synthesis(JSON.parse(JSON.parse(init.body).input))));
 const gate=pauseBatch(t,f,/INSERT INTO theme_revisions/,'before'),delivery=deliver(f,body);await gate.wait(delivery);
 assert.equal((await cancel(f,op)).state,'canceled');gate.resume();await delivery;
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_syntheses').get().n,0);
});

test('unchanged theme synthesis shortcut atomically completes without another provider call',{timeout:10000},async t=>{
 const f=await setup(t);seedThemeMaterial(f);let calls=0;
 setProviderDouble(async(_url,init)=>{calls++;return graphResponse({},synthesis(JSON.parse(JSON.parse(init.body).input)));});
 const first=await rebuildTheme(f);await deliver(f,first.body);assert.equal(calls,1);
 const next=await rebuildTheme(f),gate=pauseBatch(t,f,/UPDATE theme_jobs SET state='completed'/),delivery=deliver(f,next.body);await gate.wait(delivery);
 assert.equal(calls,1);assert.equal(state(f,next.op),'completed');assert.equal((await cancel(f,next.op)).state,'completed');
 gate.resume();await delivery;assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,1);
});

test('research final result and queued completion win together against a late stop',{timeout:10000},async t=>{
 const f=await setup(t),run=await research(f),gate=pauseBatch(t,f,/UPDATE research_runs SET state=\?,result_json=/),delivery=deliver(f,run.body);await gate.wait(delivery);
 const saved=f.db.prepare('SELECT state,result_json FROM research_runs WHERE id=?').get(run.id);
 assert.equal(saved.state,'completed');assert.ok(JSON.parse(saved.result_json).findings.length);
 assert.equal(state(f,run.op),'completed');assert.equal((await cancel(f,run.op)).state,'completed');gate.resume();await delivery;
});

test('research stop before final commit preserves saved source material but publishes no result',{timeout:10000},async t=>{
 const f=await setup(t),run=await research(f),gate=pauseBatch(t,f,/UPDATE research_runs SET state=\?,result_json=/,'before'),delivery=deliver(f,run.body);await gate.wait(delivery);
 assert.equal((await cancel(f,run.op)).state,'canceled');gate.resume();await delivery;
 const saved=f.db.prepare('SELECT state,result_json FROM research_runs WHERE id=?').get(run.id);
 assert.equal(saved.state,'canceled');assert.equal(saved.result_json,null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM research_materials WHERE state='saved'").get().n,1);
});

test('research root with an active capture child stays active until the last child result commits',{timeout:10000},async t=>{
 const f=await setup(t),run=await research(f,{child:true});await deliver(f,run.body);
 assert.equal(f.db.prepare('SELECT state FROM research_runs WHERE id=?').get(run.id).state,'completed');
 assert.ok(['running','queued'].includes(state(f,run.op)));
 const gate=pauseBatch(t,f,/INSERT OR REPLACE INTO harvests/),delivery=deliver(f,{job_id:run.childId});await gate.wait(delivery);
 assert.equal(state(f,run.op),'completed');assert.equal((await cancel(f,run.op)).state,'completed');gate.resume();await delivery;
});

test('research remains cancelable while descendants run without losing its completed result',{timeout:10000},async t=>{
 const f=await setup(t),run=await research(f,{child:true});await deliver(f,run.body);
 assert.equal((await cancel(f,run.op)).state,'canceled');await deliver(f,{job_id:run.childId});
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE id=?').get(run.childId).state,'canceled');
 const saved=f.db.prepare('SELECT state,result_json FROM research_runs WHERE id=?').get(run.id);
 assert.equal(saved.state,'completed');assert.ok(JSON.parse(saved.result_json).findings.length);
});

test('research completion ignores a dormant source capture that was never authorized for extraction',{timeout:10000},async t=>{
 const f=await setup(t),run=await research(f,{child:'dormant'}),gate=pauseBatch(t,f,/UPDATE research_runs SET state=\?,result_json=/),delivery=deliver(f,run.body);await gate.wait(delivery);
 assert.equal(state(f,run.op),'completed');assert.equal((await cancel(f,run.op)).state,'completed');
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE id=?').get(run.childId).state,'blocked');gate.resume();await delivery;
});

test('partial research saves its useful result with a failed aggregate instead of success or late cancellation',{timeout:10000},async t=>{
 const f=await setup(t),run=await research(f);
 f.db.prepare("INSERT INTO research_materials(id,run_id,url,retrieved_at,state,error_code) VALUES(?,?,'https://www.boj.or.jp/unavailable',0,'failed','retrieval_failed')").run(crypto.randomUUID(),run.id);
 const gate=pauseBatch(t,f,/UPDATE research_runs SET state=\?,result_json=/),delivery=deliver(f,run.body);await gate.wait(delivery);
 const saved=f.db.prepare('SELECT state,result_json FROM research_runs WHERE id=?').get(run.id);
 assert.equal(saved.state,'partial');assert.ok(JSON.parse(saved.result_json).findings.length);
 assert.equal(state(f,run.op),'failed');assert.equal((await cancel(f,run.op)).state,'failed');gate.resume();await delivery;
});
