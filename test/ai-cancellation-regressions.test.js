import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json,mockAi,result,graphResponse,setProviderDouble} from './helpers.js';
import {generateProposals} from '../src/integration-proposals.ts';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition){
 for(let attempt=0;attempt<400;attempt++){
  if(await condition())return;
  await delay(5);
 }
 throw Error('condition did not become true');
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function operationOptions(body,operationId,workflow){
 const options=json('POST',body);
 options.headers['x-ai-operation-id']=operationId;
 if(workflow)options.headers['x-ai-operation-workflow']=workflow;
 return options;
}
async function setup(t){
 const f=await fixture({policy:'explicit'});
 t.after(f.close);
 t.after(()=>setProviderDouble(null));
 await f.login();
 return f;
}
async function cancel(f,id){
 const response=await f.request(`/api/ai-operations/${id}/cancel`,json('POST',{}));
 assert.equal(response.status,200);
 return response.json();
}
async function snapshot(f,id){return (await f.request(`/api/ai-operations/${id}`)).json();}
async function saveOriginal(f,text='供給能力が追いつかないと価格が上昇する。'){
 const options=json('POST',{text});
 options.headers['Idempotency-Key']=crypto.randomUUID();
 const response=await f.request('/api/captures',options);
 assert.equal(response.status,201);
 const saved=await response.json();
 await f.settle();
 return saved.id;
}
async function deliver(f,body){
 assert.ok(body,'a queued message is required');
 let ack=0,retry=0;
 await f.worker.queue({queue:'cancellation-regression',messages:[{body,ack(){ack++;},retry(){retry++;}}]},f.env);
 assert.equal(retry,0,'canceled work must not be retried');
 assert.equal(ack,1);
}
function seedMaterial(f,id=crypto.randomUUID(),text='AI制作が容易になっても、作成後の検証が残る。'){
 const h=result();
 Object.assign(h,{extracted_text:text,summary:text,claims:[{id:'c1',text,conditions:[],evidence:{origin:'user',quote:text,locator:null,certainty:'explicit'}}],questions:[],concepts:[],view_draft:null,classification:{domain_ids:['work'],lens_ids:['constraint']}});
 f.db.prepare("INSERT INTO captures(id,kind,original_text,note,version,created_at,updated_at,mutation_id,request_key,request_hash) VALUES(?,'text',?,'',1,0,0,?,?,'fixture')").run(id,text,id,id);
 f.db.prepare('INSERT INTO harvests(capture_id,version,result,created_at) VALUES(?,1,?,0)').run(id,JSON.stringify(h));
 return id;
}
function synthesis(input){
 return {changed:true,change_reason:'検証という制約を整理する。',understanding:[{id:'u1',text:'制作後の検証が制約として残る場合がある。',interpretation:'ai',period:null,evidence:input.claims.map(c=>({claim_id:c.id,quote:c.evidence.quote,role:'condition'}))}],changes:[],competing:[],conditions:[],questions:[],relations:[],theme_relations:[],view_proposal:null};
}
function discoveryResult(input){
 return {candidates:input.candidates.map(c=>({id:c.id,reason:'制作後に残る検証の条件を比較する。',relation:'condition',relevance:3})),destination:{theme_id:null,question:'制作が容易になるほど検証が価値を持つのではないか？',scope:'制作と検証',exclusions:''}};
}
function answerResponse(){return graphResponse({},{answer:'供給の制約を確認します。',evidence:[]});}

test('actual extraction honors stop-before-start without creating a queued job or losing the original',{timeout:10000},async t=>{
 const f=await setup(t),capture=await saveOriginal(f),op=crypto.randomUUID();
 let calls=0;setProviderDouble(async()=>{calls++;throw Error('provider must not run');});
 assert.equal((await cancel(f,op)).state,'canceled');
 const response=await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},op));
 const data=await response.json();
 assert.equal(data.canceled,true);assert.equal(data.ai_operation.state,'canceled');
 await f.settle();
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(calls,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests').get().n,0);
 assert.ok(f.db.prepare('SELECT original_text FROM captures WHERE id=?').get(capture).original_text);
});

test('duplicate tabs reuse the canonical extraction operation and never steal its job',{timeout:10000},async t=>{
 const f=await setup(t),capture=await saveOriginal(f),first=crypto.randomUUID(),duplicate=crypto.randomUUID();
 const start=await (await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},first))).json();
 assert.equal(start.ai_operation.id,first);
 const second=await (await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},duplicate))).json();
 assert.equal(second.ai_operation.id,first);
 const owner=f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='capture'").get();
 assert.equal(owner.operation_id,first);
 await cancel(f,duplicate);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(capture).state,'pending');
 assert.equal((await cancel(f,second.ai_operation.id)).state,'canceled');
 await f.settle();
 let calls=0;setProviderDouble(async()=>{calls++;throw Error('provider must not run');});
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(calls,0);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(capture).state,'canceled');
});

test('a canceled extraction can retry while the old provider response is delayed',{timeout:10000},async t=>{
 const f=await setup(t),capture=await saveOriginal(f),old=crypto.randomUUID(),retry=crypto.randomUUID();
 await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},old));await f.settle();
 const gate=deferred();let calls=0;
 setProviderDouble(async(...args)=>{calls++;if(calls===1)await gate.promise;return mockAi(...args);});
 const stoppedWork=deliver(f,f.messages.shift());
 await until(()=>calls===1);await cancel(f,old);
 const response=await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},retry));
 assert.equal((await response.json()).ai_operation.id,retry);await f.settle();
 gate.resolve();await stoppedWork;
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests').get().n,0);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(capture).state,'pending');
 await cancel(f,old);
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(calls,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests').get().n,1);
 assert.equal((await snapshot(f,old)).state,'canceled');
 assert.equal((await snapshot(f,retry)).state,'completed');
});

test('stopping between extraction and discovery preserves completed extraction and prevents the next stage',{timeout:10000},async t=>{
 const f=await setup(t),capture=await saveOriginal(f),op=crypto.randomUUID();
 let calls=0;setProviderDouble(async(...args)=>{calls++;return mockAi(...args);});
 await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},op,'text-discovery'));await f.settle();
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests').get().n,1);
 assert.ok(['queued','running'].includes((await snapshot(f,op)).state),'the overall workflow stays active between stages');
 assert.equal((await cancel(f,op)).state,'canceled');
 const response=await f.request('/api/book/discover',operationOptions({id:capture,version:1,idempotency_key:crypto.randomUUID()},op,'text-discovery'));
 assert.equal((await response.json()).canceled,true);
 assert.equal(calls,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM discovery_runs').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests').get().n,1);
});

test('stopping discovery search-plan AI never starts relation judgment or leaves a running result',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedMaterial(f),op=crypto.randomUUID(),gate=deferred();
 seedMaterial(f);const formats=[];
 setProviderDouble(async(_url,options)=>{
  const payload=JSON.parse(options.body);formats.push(payload.text.format.name);await gate.promise;
  return graphResponse({},{queries:[{kind:'direct',terms:['AI','制作','検証','仕事']}]});
 });
 const pending=f.request('/api/book/discover',operationOptions({id:capture,version:1,idempotency_key:crypto.randomUUID()},op));
 await until(()=>formats.length===1);await cancel(f,op);gate.resolve();
 const response=await pending;assert.equal((await response.json()).canceled,true);
 assert.deepEqual(formats,['discovery_search_plan_v1']);
 const row=f.db.prepare('SELECT state,result_json FROM discovery_runs').get();
 assert.notEqual(row.state,'running');assert.equal(row.result_json,null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM book_operation_receipts WHERE state='running'").get().n,0);
 assert.equal((await snapshot(f,op)).state,'canceled');
});

test('an answer canceled at the final save boundary cannot overwrite or append saved results',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedMaterial(f),op=crypto.randomUUID();
 const prior=JSON.stringify({answer:'以前の回答',evidence:[]});
 f.db.prepare("INSERT INTO answers(id,capture_id,version,question,result,created_at) VALUES('prior',?,1,'以前の質問',?,0)").run(capture,prior);
 setProviderDouble(async()=>answerResponse());
 const originalBatch=f.env.DB.batch.bind(f.env.DB);let canceledBeforeSave=false;
 f.env.DB.batch=async statements=>{
  if(!canceledBeforeSave&&statements.some(s=>/INSERT INTO answers\b/.test(s.sql))){
   canceledBeforeSave=true;await cancel(f,op);
  }
  return originalBatch(statements);
 };
 const response=await f.request(`/api/captures/${capture}/ask`,operationOptions({version:1,question:'供給の制約は？'},op));
 assert.equal((await response.json()).canceled,true);assert.equal(canceledBeforeSave,true);
 assert.deepEqual(f.db.prepare('SELECT id,result FROM answers').all().map(row=>({...row})),[{id:'prior',result:prior}]);
});

test('replayed in-flight and completed inline operation IDs do not repeat AI or saved answers',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedMaterial(f),op=crypto.randomUUID(),gate=deferred();let calls=0;
 setProviderDouble(async()=>{calls++;await gate.promise;return answerResponse();});
 const args={version:1,question:'供給の制約は？'};
 const pending=f.request(`/api/captures/${capture}/ask`,operationOptions(args,op));
 await until(()=>calls===1);
 const duplicate=await f.request(`/api/captures/${capture}/ask`,operationOptions(args,op));
 assert.equal(duplicate.status,202);assert.equal((await duplicate.json()).ai_operation.id,op);
 assert.equal(calls,1);gate.resolve();
 assert.equal((await (await pending).json()).ai_operation.state,'completed');
 const replay=await f.request(`/api/captures/${capture}/ask`,operationOptions(args,op));
 assert.equal((await replay.json()).ai_operation.state,'completed');
 assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM answers').get().n,1);
 assert.equal((await cancel(f,op)).state,'completed');
});

test('stopped batch integration keeps completed proposals, releases the running proposal, and retries only unfinished work',{timeout:10000},async t=>{
 const f=await setup(t);for(const id of ['a','b','c','d','e','f'])seedMaterial(f,id,`AI制作後に検証が必要になる条件 ${id}`);
 const run=await generateProposals(f.env,{idempotency_key:'cancellation-proposals'},async()=>graphResponse({},{proposals:[['a','b'],['c','d'],['e','f']].map(material_ids=>({material_ids,theme_id:null,question:'AI制作が容易になるほど、検証が価値の源泉になるのではないか？',hypothesis:'AI制作が容易になるほど、検証が価値の源泉になる。',falsifier:'検証なしでも同じ品質と継続対価が得られる。',scope:'制作',exclusions:'',reason:'制作後に残る検証という条件を比較する。'}))}));
 assert.equal(run.proposals.length,3);
 const op=crypto.randomUUID(),gate=deferred();let calls=0;
 setProviderDouble(async(_url,options)=>{calls++;const input=JSON.parse(JSON.parse(options.body).input);if(calls===2)await gate.promise;return graphResponse({},synthesis(input));});
 const args={run_id:run.id,selected_ids:run.proposals.map(p=>p.id)};
 const pending=f.request('/api/book/integration-proposals/execute',operationOptions(args,op));
 await until(()=>calls===2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,1);
 await cancel(f,op);
 // Confirmation alone releases the running attempt; the provider has not returned
 // and no catch/finally from the original request has run yet.
 assert.equal(f.db.prepare("SELECT count(*) n FROM integration_runs WHERE state='running'").get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM integration_proposals WHERE state='running'").get().n,0);
 gate.resolve();assert.equal((await (await pending).json()).canceled,true);
 const states=f.db.prepare('SELECT state FROM integration_proposals ORDER BY position').all().map(p=>p.state);
 assert.equal(states[0],'completed');assert.ok(['failed','canceled'].includes(states[1]));assert.equal(states[2],'pending');
 assert.equal(f.db.prepare("SELECT count(*) n FROM integration_runs WHERE state='running'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,1);
 assert.equal(calls,2,'a stop must not start the next proposal');
 const retry=crypto.randomUUID();
 const response=await f.request('/api/book/integration-proposals/execute',operationOptions({...args,retry:true},retry));
 const data=await response.json();
 assert.equal(response.status,200);assert.equal(data.ai_operation.state,'completed');
 assert.ok(data.proposals.every(p=>p.state==='completed'));
 assert.equal(calls,4);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,3);
 assert.equal((await snapshot(f,op)).state,'canceled');
});

test('stopped proposal generation has a terminal run and a fresh request can regenerate proposals',{timeout:10000},async t=>{
 const f=await setup(t);seedMaterial(f,'a','AI制作後には検証という制約が残る。');seedMaterial(f,'b','AIで仕事の制作が速まるほど、検証が価値になる。');
 const op=crypto.randomUUID(),gate=deferred();let calls=0;
 setProviderDouble(async()=>{calls++;await gate.promise;return graphResponse({},{proposals:[]});});
 const pending=f.request('/api/book/integration-proposals',operationOptions({idempotency_key:crypto.randomUUID()},op));
 await until(()=>calls===1);await cancel(f,op);
 assert.equal(f.db.prepare("SELECT count(*) n FROM integration_proposal_runs WHERE state='running'").get().n,0);
 gate.resolve();
 assert.equal((await (await pending).json()).canceled,true);
 assert.equal(f.db.prepare("SELECT count(*) n FROM integration_proposal_runs WHERE state='running'").get().n,0);
 const retry=await f.request('/api/book/integration-proposals',operationOptions({idempotency_key:crypto.randomUUID()},crypto.randomUUID()));
 assert.equal((await retry.json()).ai_operation.state,'completed');assert.equal(calls,2);
});

test('successful extraction and discovery share one operation that finishes only after discovery',{timeout:10000},async t=>{
 const f=await setup(t),capture=await saveOriginal(f),op=crypto.randomUUID();
 const formats=[];
 setProviderDouble(async(url,options)=>{
  const payload=JSON.parse(options.body),name=payload.text.format.name;formats.push(name);
  if(name==='discovery_search_plan_v1')return graphResponse({},{queries:[{kind:'direct',terms:['供給','能力','価格']}]});
  if(name==='related_discovery_v1')return graphResponse({},discoveryResult(JSON.parse(payload.input)));
  return mockAi(url,options);
 });
 const first=await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},op,'text-discovery'));
 assert.equal(first.status,202);await f.settle();for(const body of f.messages.splice(0))await deliver(f,body);
 assert.ok(['running','queued'].includes((await snapshot(f,op)).state));
 const args={id:capture,version:1,idempotency_key:crypto.randomUUID()};
 const second=await f.request('/api/book/discover',operationOptions(args,op,'text-discovery'));
 const data=await second.json();assert.equal(second.status,202,JSON.stringify({data,formats,runs:f.db.prepare('SELECT state,error FROM discovery_runs').all()}));assert.equal(data.ai_operation.id,op);assert.equal(data.ai_operation.state,'completed');
 assert.equal(f.db.prepare("SELECT count(*) n FROM discovery_runs WHERE state='completed'").get().n,1);
 const before=formats.length;
 const replay=await f.request('/api/book/discover',operationOptions(args,op,'text-discovery'));
 assert.equal((await replay.json()).ai_operation.state,'completed');assert.equal(formats.length,before);
});

test('a combined workflow cannot take over extraction already owned by another operation',{timeout:10000},async t=>{
 const f=await setup(t),capture=await saveOriginal(f),owner=crypto.randomUUID(),contender=crypto.randomUUID();
 await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},owner));
 const response=await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},contender,'text-discovery'));
 assert.equal(response.status,409);
 assert.equal(f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='capture'").get().operation_id,owner);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(capture).state,'pending');
});

test('stopping one actual answer leaves an independent answer running and able to save',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedMaterial(f),a=crypto.randomUUID(),b=crypto.randomUUID();
 const gateA=deferred(),gateB=deferred();let calls=0;
 setProviderDouble(async(_url,options)=>{
  const input=JSON.parse(JSON.parse(options.body).input);calls++;
  await (input.question==='質問A'?gateA.promise:gateB.promise);
  return answerResponse();
 });
 const first=f.request(`/api/captures/${capture}/ask`,operationOptions({version:1,question:'質問A'},a));
 const second=f.request(`/api/captures/${capture}/ask`,operationOptions({version:1,question:'質問B'},b));
 await until(()=>calls===2);await cancel(f,a);
 assert.equal((await snapshot(f,b)).state,'running');gateA.resolve();gateB.resolve();
 assert.equal((await (await first).json()).canceled,true);
 assert.equal((await (await second).json()).ai_operation.state,'completed');
 assert.deepEqual(f.db.prepare('SELECT question FROM answers').all().map(r=>r.question),['質問B']);
});

test('when the answer save commits first a later stop reports completed and retains the answer',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedMaterial(f),op=crypto.randomUUID();
 setProviderDouble(async()=>answerResponse());
 const originalBatch=f.env.DB.batch.bind(f.env.DB);let stateAtStop;
 f.env.DB.batch=async statements=>{
  const result=await originalBatch(statements);
  if(stateAtStop===undefined&&statements.some(s=>/INSERT INTO answers\b/.test(s.sql))){
   stateAtStop='checking';stateAtStop=(await cancel(f,op)).state;
  }
  return result;
 };
 const response=await f.request(`/api/captures/${capture}/ask`,operationOptions({version:1,question:'供給の制約は？'},op));
 const data=await response.json();
 assert.equal(stateAtStop,'completed');assert.equal(data.ai_operation.state,'completed');assert.notEqual(data.canceled,true);
 assert.equal(f.db.prepare('SELECT count(*) n FROM answers').get().n,1);
});

test('a committed proposal result is reconciled when stop wins before its proposal status update',{timeout:10000},async t=>{
 const f=await setup(t);for(const id of ['a','b','c','d'])seedMaterial(f,id,`AI制作後の検証条件 ${id}`);
 const run=await generateProposals(f.env,{idempotency_key:'proposal-commit-race'},async()=>graphResponse({},{proposals:[['a','b'],['c','d']].map(material_ids=>({material_ids,theme_id:null,question:'AI制作が容易になるほど、検証が価値の源泉になるのではないか？',hypothesis:'AI制作が容易になるほど、検証が価値の源泉になる。',falsifier:'検証なしでも同じ品質と継続対価が得られる。',scope:'制作',exclusions:'',reason:'制作後に残る検証という条件を比較する。'}))}));
 const op=crypto.randomUUID();let calls=0,stopped=false;
 setProviderDouble(async(_url,options)=>{calls++;return graphResponse({},synthesis(JSON.parse(JSON.parse(options.body).input)));});
 const originalBatch=f.env.DB.batch.bind(f.env.DB);
 f.env.DB.batch=async statements=>{
  const output=await originalBatch(statements);
  if(!stopped&&statements.some(s=>/UPDATE integration_runs SET state='completed'/.test(s.sql))){
   stopped=true;assert.equal((await cancel(f,op)).state,'canceled');
  }
  return output;
 };
 const args={run_id:run.id,selected_ids:run.proposals.map(p=>p.id)};
 const response=await f.request('/api/book/integration-proposals/execute',operationOptions(args,op));
 assert.equal((await response.json()).canceled,true);assert.equal(stopped,true);
 const proposals=f.db.prepare('SELECT state,result_json FROM integration_proposals ORDER BY position').all();
 assert.equal(proposals[0].state,'completed');assert.ok(JSON.parse(proposals[0].result_json).theme_id);
 assert.equal(proposals[1].state,'pending');assert.equal(calls,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,1);
 const retry=await f.request('/api/book/integration-proposals/execute',operationOptions({...args,retry:true},crypto.randomUUID()));
 assert.equal((await retry.json()).ai_operation.state,'completed');assert.equal(calls,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,2);
});

test('stop after search planning but before discovery judgment prevents a second AI request',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedMaterial(f),op=crypto.randomUUID();seedMaterial(f);
 const formats=[];setProviderDouble(async(_url,options)=>{
  const payload=JSON.parse(options.body);formats.push(payload.text.format.name);
  return graphResponse({},{queries:[{kind:'direct',terms:['AI','制作','検証']}]});
 });
 const originalBatch=f.env.DB.batch.bind(f.env.DB);let stopped=false;
 f.env.DB.batch=async statements=>{
  if(!stopped&&statements.some(s=>/^UPDATE discovery_runs SET input_json=/.test(s.sql))){stopped=true;await cancel(f,op);}
  return originalBatch(statements);
 };
 const response=await f.request('/api/book/discover',operationOptions({id:capture,version:1,idempotency_key:crypto.randomUUID()},op));
 assert.equal((await response.json()).canceled,true);assert.equal(stopped,true);
 assert.deepEqual(formats,['discovery_search_plan_v1']);
 const row=f.db.prepare('SELECT state,result_json FROM discovery_runs').get();
 assert.notEqual(row.state,'running');assert.equal(row.result_json,null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM book_operation_receipts WHERE state='running'").get().n,0);
});

test('theme plan final-save cancellation preserves the existing theme and finalizes its receipt',{timeout:10000},async t=>{
 const f=await setup(t),op=crypto.randomUUID();
 const before={...f.db.prepare("SELECT * FROM themes WHERE id='theme:work'").get()};
 const originalBatch=f.env.DB.batch.bind(f.env.DB);let stopped=false;
 f.env.DB.batch=async statements=>{
  if(!stopped&&statements.some(s=>/^INSERT INTO theme_changes\b/.test(s.sql))){stopped=true;await cancel(f,op);}
  return originalBatch(statements);
 };
 const response=await f.request('/api/theme-changes',operationOptions({id:'theme:work',version:1,action:'edit',question:'検証が価値になる条件は？',reason:'問いを限定する。',idempotency_key:crypto.randomUUID()},op));
 assert.equal((await response.json()).canceled,true);assert.equal(stopped,true);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_changes').get().n,0);
 assert.deepEqual({...f.db.prepare("SELECT * FROM themes WHERE id='theme:work'").get()},before);
 assert.equal(f.db.prepare("SELECT count(*) n FROM book_operation_receipts WHERE state='running'").get().n,0);
});

test('completed theme plan remains readable and reports completed if stopped after its commit',{timeout:10000},async t=>{
 const f=await setup(t),op=crypto.randomUUID();
 const response=await f.request('/api/theme-changes',operationOptions({id:'theme:work',version:1,action:'edit',question:'検証が価値になる条件は？',reason:'問いを限定する。',idempotency_key:crypto.randomUUID()},op));
 const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));assert.equal(data.ai_operation.state,'completed');
 assert.equal((await cancel(f,op)).state,'completed');
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_changes').get().n,1);
 assert.equal(f.db.prepare("SELECT state FROM book_operation_receipts").get().state,'completed');
});

test('a stopped concept plan never saves late provider output or changes source concepts',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedMaterial(f),op=crypto.randomUUID(),gate=deferred();
 f.db.prepare("INSERT INTO graph_generations(id,capture_id,version,active,result,model,processing_version,input_snapshot,created_at) VALUES('fixture-generation',?,1,1,'{}','fixture','fixture','{}',0)").run(capture);
 f.db.prepare("INSERT INTO graph_nodes(id,generation_id,local_id,kind,text,payload) VALUES('fixture-node','fixture-generation','k1','concept','供給制約','{}')").run();
 f.db.prepare("INSERT INTO concepts VALUES('fixture-concept','供給制約','需要に供給能力が追いつかないこと',0)").run();
 f.db.prepare("INSERT INTO concept_mentions VALUES('fixture-node','fixture-concept','new','fixture','[]')").run();
 let calls=0;setProviderDouble(async()=>{calls++;await gate.promise;return graphResponse({},{name:'設備の制約',meaning:'選択した設備の能力制約',reason:'対象を区別する。',warnings:[]});});
 const pending=f.request('/api/concept-edits',operationOptions({action:'split',node_ids:['fixture-node'],reason:'この文脈だけ区別する。'},op));
 await until(()=>calls===1);await cancel(f,op);gate.resolve();
 assert.equal((await (await pending).json()).canceled,true);
 assert.equal(f.db.prepare('SELECT count(*) n FROM concept_edits').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM concept_overrides').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM concepts').get().n,1);
});

test('legacy child jobs acquire ownership in the result transaction before queue publication',{timeout:10000},async t=>{
 const f=await setup(t);f.env.AI_EXECUTION_POLICY='automatic_legacy';
 const op=crypto.randomUUID(),options=operationOptions({text:'供給能力が追いつかないと価格が上昇する。'},op);
 options.headers['Idempotency-Key']=crypto.randomUUID();
 const saved=await (await f.request('/api/captures',options)).json();await f.settle();
 let calls=0;setProviderDouble(async(...args)=>{calls++;return mockAi(...args);});
 const originalBatch=f.env.DB.batch.bind(f.env.DB);let inspected=false;
 f.env.DB.batch=async statements=>{
  const output=await originalBatch(statements);
  if(!inspected&&statements.some(s=>/^INSERT OR REPLACE INTO harvests\b/.test(s.sql))){
   inspected=true;
   for(const kind of ['graph','theme']){
    const owned=f.db.prepare('SELECT operation_id FROM ai_operation_jobs WHERE kind=?').all(kind);
    assert.ok(owned.length>0,`${kind} must be owned before any child queue send`);
    assert.ok(owned.every(row=>row.operation_id===op));
   }
   assert.equal(f.messages.length,0,'no child is published before its owner is durable');
   assert.equal((await cancel(f,op)).state,'canceled');
  }
  return output;
 };
 await deliver(f,f.messages.shift());
 assert.equal(inspected,true);assert.equal(calls,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests WHERE capture_id=?').get(saved.id).n,1);
 for(const table of ['graph_jobs','theme_jobs'])assert.ok(f.db.prepare(`SELECT state FROM ${table}`).all().every(j=>j.state==='canceled'));
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_operation_fences').get().n,0,'transaction-local ownership markers are removed');
});

test('stopping a legacy root cannot steal or cancel an independently owned existing child',{timeout:10000},async t=>{
 const f=await setup(t);f.env.AI_EXECUTION_POLICY='automatic_legacy';
 const root=crypto.randomUUID(),independent=crypto.randomUUID(),graphJob=crypto.randomUUID();
 const options=operationOptions({text:'供給能力が追いつかないと価格が上昇する。'},root);options.headers['Idempotency-Key']=crypto.randomUUID();
 const saved=await (await f.request('/api/captures',options)).json();await f.settle();
 f.db.prepare("INSERT INTO ai_operations(id,path,label,mode,state,created_at,updated_at) VALUES(?,'/api/graph/rebuild','独立した再構成','queued','running',0,0)").run(independent);
 f.db.prepare("INSERT INTO graph_jobs(id,capture_id,version,state,available_at,created_at) VALUES(?,?,1,'pending',0,0)").run(graphJob,saved.id);
 f.db.prepare("INSERT INTO ai_operation_jobs VALUES('graph',?,'1',?)").run(graphJob,independent);
 setProviderDouble(mockAi);
 const originalBatch=f.env.DB.batch.bind(f.env.DB);let stopped=false;
 f.env.DB.batch=async statements=>{
  const output=await originalBatch(statements);
  if(!stopped&&statements.some(s=>/^INSERT OR REPLACE INTO harvests\b/.test(s.sql))){
   stopped=true;await cancel(f,root);
  }
  return output;
 };
 await deliver(f,f.messages.shift());assert.equal(stopped,true);
 assert.equal(f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='graph' AND job_id=?").get(graphJob).operation_id,independent);
 assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE id=?').get(graphJob).state,'pending');
 assert.equal((await snapshot(f,independent)).state,'queued');
 assert.equal((await snapshot(f,root)).state,'canceled');
});

test('direct integration can retry after stop with a fresh key and never saves the late first result',{timeout:10000},async t=>{
 const f=await setup(t);seedMaterial(f,'a','AI制作後には検証という制約が残る。');seedMaterial(f,'b','AIで仕事の制作が速まるほど、検証が価値になる。');
 const proposal={material_ids:['a','b'],theme_id:null,question:'AI制作が容易になるほど、検証が価値の源泉になるのではないか？',hypothesis:'AI制作が容易になるほど、検証が価値の源泉になる。',falsifier:'検証なしでも同じ品質と継続対価が得られる。',scope:'制作',exclusions:'',reason:'制作後に残る検証という条件を比較する。'};
 const run=await generateProposals(f.env,{idempotency_key:'direct-integration-stop'},async()=>graphResponse({},{proposals:[proposal]}));
 const op=crypto.randomUUID(),gate=deferred();let calls=0;
 setProviderDouble(async(_url,options)=>{calls++;const input=JSON.parse(JSON.parse(options.body).input);if(calls===1)await gate.promise;return graphResponse({},synthesis(input));});
 const args={discovery_id:run.proposals[0].discovery_id,selected_ids:['b'],idempotency_key:crypto.randomUUID()};
 const pending=f.request('/api/book/integrate',operationOptions(args,op));
 await until(()=>calls===1);await cancel(f,op);gate.resolve();
 assert.equal((await (await pending).json()).canceled,true);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM integration_runs WHERE state='running'").get().n,0);
 const retry=await f.request('/api/book/integrate',operationOptions({...args,idempotency_key:crypto.randomUUID()},crypto.randomUUID()));
 const data=await retry.json();assert.equal(retry.status,200,JSON.stringify(data));assert.equal(data.ai_operation.state,'completed');
 assert.equal(calls,2);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,1);
 assert.equal((await snapshot(f,op)).state,'canceled');
});

test('the final batch integration commit wins a later stop even with completed proposals trailing in the selection',{timeout:10000},async t=>{
 const f=await setup(t);for(const id of ['a','b','c','d'])seedMaterial(f,id,`AI制作後の検証条件 ${id}`);
 const run=await generateProposals(f.env,{idempotency_key:'final-proposal-commit-race'},async()=>graphResponse({},{proposals:[['a','b'],['c','d']].map(material_ids=>({material_ids,theme_id:null,question:'AI制作が容易になるほど、検証が価値の源泉になるのではないか？',hypothesis:'AI制作が容易になるほど、検証が価値の源泉になる。',falsifier:'検証なしでも同じ品質と継続対価が得られる。',scope:'制作',exclusions:'',reason:'制作後に残る検証という条件を比較する。'}))}));
 let calls=0;setProviderDouble(async(_url,options)=>{calls++;return graphResponse({},synthesis(JSON.parse(JSON.parse(options.body).input)));});
 const initial=await f.request('/api/book/integration-proposals/execute',operationOptions({run_id:run.id,selected_ids:[run.proposals[0].id]},crypto.randomUUID()));
 assert.equal((await initial.json()).proposals[0].state,'completed');
 const op=crypto.randomUUID(),originalBatch=f.env.DB.batch.bind(f.env.DB);let stateAtStop;
 f.env.DB.batch=async statements=>{
  const output=await originalBatch(statements);
  if(stateAtStop===undefined&&statements.some(s=>/UPDATE integration_runs SET state='completed'/.test(s.sql))){
   stateAtStop='checking';stateAtStop=(await cancel(f,op)).state;
  }
  return output;
 };
 const args={run_id:run.id,selected_ids:[run.proposals[1].id,run.proposals[0].id]};
 const response=await f.request('/api/book/integration-proposals/execute',operationOptions(args,op));
 const data=await response.json();
 assert.equal(response.status,200,JSON.stringify(data));assert.equal(stateAtStop,'completed');
 assert.equal(data.ai_operation.state,'completed');assert.notEqual(data.canceled,true);
 assert.ok(data.proposals.every(p=>p.state==='completed'));
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,2);assert.equal(calls,2);
 const replay=await f.request('/api/book/integration-proposals/execute',operationOptions(args,op));
 assert.equal((await replay.json()).ai_operation.state,'completed');assert.equal(calls,2);
});

test('capture detail stop cancels the canonical operation and a stale version cannot stop a newer extraction',{timeout:10000},async t=>{
 const f=await setup(t),capture=await saveOriginal(f),first=crypto.randomUUID(),newer=crypto.randomUUID();
 let calls=0;setProviderDouble(async()=>{calls++;throw Error('canceled queues must not call AI');});
 await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},first));await f.settle();
 const stopped=await (await f.request(`/api/captures/${capture}/cancel-extraction`,json('POST',{version:1}))).json();
 assert.equal(stopped.ai_operation.id,first);assert.equal(stopped.ai_operation.state,'canceled');
 assert.equal((await snapshot(f,first)).state,'canceled');
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=? AND version=1').get(capture).state,'canceled');
 assert.equal((await f.request(`/api/captures/${capture}`,json('PATCH',{version:1,note:'条件を訂正する。'}))).status,200);
 await f.request(`/api/captures/${capture}/extract`,operationOptions({version:2},newer));await f.settle();
 await f.request(`/api/captures/${capture}/cancel-extraction`,json('POST',{version:1}));
 assert.ok(['running','queued'].includes((await snapshot(f,newer)).state));
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=? AND version=2').get(capture).state,'pending');
 const stoppedNew=await (await f.request(`/api/captures/${capture}/cancel-extraction`,json('POST',{version:2}))).json();
 assert.equal(stoppedNew.ai_operation.id,newer);assert.equal(stoppedNew.ai_operation.state,'canceled');
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM harvests').get().n,0);
});

test('research detail stop cancels the canonical queued operation before its provider starts',{timeout:10000},async t=>{
 const f=await setup(t),op=crypto.randomUUID(),options=operationOptions({question:'供給制約が価格に及ぼす条件は？'},op);
 options.headers['Idempotency-Key']=crypto.randomUUID();
 const start=await f.request('/api/research',options);const saved=await start.json();
 assert.equal(start.status,202,JSON.stringify(saved));assert.equal(saved.ai_operation.id,op);await f.settle();
 let calls=0;setProviderDouble(async()=>{calls++;throw Error('canceled research must not call AI');});
 const response=await f.request(`/api/research/${saved.id}/cancel`,json('POST',{}));const data=await response.json();
 assert.equal(response.status,200);assert.equal(data.ai_operation.id,op);assert.equal(data.ai_operation.state,'canceled');
 assert.equal((await snapshot(f,op)).state,'canceled');
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT state FROM research_runs WHERE id=?').get(saved.id).state,'canceled');
 assert.equal(f.db.prepare('SELECT count(*) n FROM research_materials').get().n,0);
});

test('distinct operation IDs replaying the same in-flight integration key cannot report a false completion or steal ownership',{timeout:10000},async t=>{
 const f=await setup(t);seedMaterial(f,'a','AI制作後には検証という制約が残る。');seedMaterial(f,'b','AIで仕事の制作が速まるほど、検証が価値になる。');
 const proposal={material_ids:['a','b'],theme_id:null,question:'AI制作が容易になるほど、検証が価値の源泉になるのではないか？',hypothesis:'AI制作が容易になるほど、検証が価値の源泉になる。',falsifier:'検証なしでも同じ品質と継続対価が得られる。',scope:'制作',exclusions:'',reason:'制作後に残る検証という条件を比較する。'};
 const run=await generateProposals(f.env,{idempotency_key:'duplicate-integration-key'},async()=>graphResponse({},{proposals:[proposal]}));
 const first=crypto.randomUUID(),duplicate=crypto.randomUUID(),gate=deferred();let calls=0;
 setProviderDouble(async(_url,options)=>{calls++;const input=JSON.parse(JSON.parse(options.body).input);await gate.promise;return graphResponse({},synthesis(input));});
 const args={discovery_id:run.proposals[0].discovery_id,selected_ids:['b'],idempotency_key:crypto.randomUUID()};
 const pending=f.request('/api/book/integrate',operationOptions(args,first));
 await until(()=>calls===1);
 const response=await f.request('/api/book/integrate',operationOptions(args,duplicate));const data=await response.json();
 const originalState=(await snapshot(f,first)).state;
 await cancel(f,duplicate);
 const afterDuplicateStop=(await snapshot(f,first)).state;
 gate.resolve();const original=await (await pending).json();
 assert.ok([202,409].includes(response.status),JSON.stringify({status:response.status,data}));
 assert.notEqual(data.ai_operation?.state,'completed');assert.equal(originalState,'running');assert.equal(afterDuplicateStop,'running');
 assert.equal(original.ai_operation.id,first);assert.equal(original.ai_operation.state,'completed');
 assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM integration_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,1);
});

test('an explicit MCP extraction retry after a web stop is not blocked by the canceled operation owner',{timeout:10000},async t=>{
 const {callBook}=await import('../src/book-operations.ts');
 const f=await setup(t),capture=await saveOriginal(f),op=crypto.randomUUID();
 await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},op));await f.settle();
 await cancel(f,op);for(const body of f.messages.splice(0))await deliver(f,body);
 let calls=0;setProviderDouble(async(...args)=>{calls++;return mockAi(...args);});
 const retry=await callBook(f.env,f.ctx,'retry_job',{id:capture,kind:'capture',version:1,idempotency_key:crypto.randomUUID()});
 assert.equal(retry.status,202,JSON.stringify(retry));await f.settle();
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(capture).state,'pending');
 const owner=f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='capture'").get().operation_id;
 assert.notEqual(owner,op);
 // A delayed old registration and a repeated Stop cannot reclaim the retry.
 const {attachRootJob,getOperation}=await import('../src/ai-operation-jobs.ts');
 await attachRootJob(f.env,await getOperation(f.env,op),`/api/captures/${capture}/extract`,{});
 await cancel(f,op);
 assert.equal(f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='capture'").get().operation_id,owner);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(capture).state,'pending');
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM harvests WHERE capture_id=?').get(capture).n,1);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(capture).state,'completed');
 assert.equal((await snapshot(f,op)).state,'canceled');
});

test('legacy original-save transaction assigns canceled root ownership before another dispatcher can see the job',async t=>{
 const f=await setup(t);f.env.AI_EXECUTION_POLICY='automatic_legacy';
 const op=crypto.randomUUID();await cancel(f,op);
 const rawBatch=f.env.DB.batch.bind(f.env.DB);let checked=false;
 f.env.DB.batch=async statements=>{
  const results=await rawBatch(statements);
  if(statements.some(s=>/^INSERT INTO jobs\b/.test(s.sql))){
   checked=true;
   const root=f.db.prepare("SELECT j.id,l.operation_id FROM jobs j LEFT JOIN ai_operation_jobs l ON l.kind='capture' AND l.job_id=j.id AND l.generation=CAST(j.version AS TEXT)").get();
   assert.equal(root.operation_id,op);
   assert.equal(f.db.prepare('SELECT count(*) n FROM ai_operation_registrations').get().n,0);
  }
  return results;
 };
 const options=operationOptions({text:'供給能力が追いつかないと価格が上昇する。'},op);options.headers['Idempotency-Key']=crypto.randomUUID();
 const response=await f.request('/api/captures',options);assert.equal(response.status,201);assert.ok(checked);
 assert.equal(f.db.prepare('SELECT count(*) n FROM captures').get().n,1);
 assert.equal(f.db.prepare('SELECT state FROM jobs').get().state,'canceled');
 await f.settle();let calls=0;setProviderDouble(async()=>{calls++;throw Error('must remain stopped');});
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(calls,0);
});

async function saveEpub(f){
 const {makeEpub}=await import('./document-fixtures.js');
 const form=new FormData();form.set('file',new Blob([makeEpub()],{type:'application/epub+zip'}),'fixture.epub');
 const response=await f.request('/api/imports',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:form});
 assert.equal(response.status,201);const saved=await response.json();await f.settle();return saved.id;
}
async function importedProvider(url,options){
 const payload=JSON.parse(options.body);
 if(payload.text?.format?.name!=='capture_harvest_v1')return mockAi(url,options);
 const input=JSON.parse(payload.input[0].content[0].text),text=input.original_or_corrected_text;
 const h=result();h.extracted_text=text;h.summary=text;h.claims[0].text=text;h.claims[0].evidence.quote=text;
 return graphResponse({},h);
}
async function drainWrapped(f){
 const {dispatch}=await import('../src/queue.ts');
 await f.settle();
 while(f.messages.length){await deliver(f,f.messages.shift());await dispatch(f.env);await f.settle();}
}

test('explicit EPUB parse finishes its operation and later selection renews ownership before saving its capture',{timeout:10000},async t=>{
 const f=await setup(t),id=await saveEpub(f),op=crypto.randomUUID();let calls=0;
 setProviderDouble(async(...args)=>{calls++;return importedProvider(...args);});
 const start=await f.request(`/api/imports/${id}/extract`,operationOptions({},op));assert.equal(start.status,202);await drainWrapped(f);
 const parsed=await (await f.request(`/api/imports/${id}`)).json();
 assert.equal(parsed.state,'ready');assert.equal(parsed.items.length,2);assert.equal(calls,0);
 assert.equal((await snapshot(f,op)).state,'completed');
 const select=await f.request(`/api/imports/${id}/select`,json('POST',{ordinals:[1]}));assert.equal(select.status,202);await drainWrapped(f);
 const selected=await (await f.request(`/api/imports/${id}`)).json();
 assert.ok(selected.items[0].capture_id,'the selected chapter must not be suppressed by the completed parse owner');
 assert.equal(selected.items[1].capture_id,null);
 assert.equal(f.db.prepare('SELECT count(*) n FROM captures').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests').get().n,1);assert.equal(calls,1);
 const owner=f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='import' AND job_id=?").get(id).operation_id;
 assert.notEqual(owner,op);assert.equal((await snapshot(f,owner)).state,'completed');assert.equal((await snapshot(f,op)).state,'completed');
});

test('an import retry after a failed operation gets a fresh owner and can parse the saved original',{timeout:10000},async t=>{
 const f=await setup(t),id=await saveEpub(f),op=crypto.randomUUID();
 const get=f.env.ORIGINALS.get;f.env.ORIGINALS.get=async()=>null;
 await f.request(`/api/imports/${id}/extract`,operationOptions({},op));await drainWrapped(f);
 assert.equal(f.db.prepare('SELECT state FROM import_jobs WHERE id=?').get(id).state,'failed');
 assert.equal((await snapshot(f,op)).state,'failed');f.env.ORIGINALS.get=get;
 const response=await f.request(`/api/imports/${id}/retry`,json('POST',{}));assert.equal(response.status,202);await drainWrapped(f);
 const parsed=await (await f.request(`/api/imports/${id}`)).json();assert.equal(parsed.state,'ready');assert.equal(parsed.items.length,2);
 const owner=f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='import' AND job_id=?").get(id).operation_id;
 assert.notEqual(owner,op);assert.equal((await snapshot(f,owner)).state,'completed');assert.equal((await snapshot(f,op)).state,'failed');
 assert.equal((await f.request(`/api/imports/${id}/original`)).status,200);
});

test('duplicate graph rebuilds for the same capture reuse the existing canonical operation',{timeout:10000},async t=>{
 const f=await setup(t),capture=seedMaterial(f),first=crypto.randomUUID(),duplicate=crypto.randomUUID(),args={capture_ids:[capture]};
 const start=await f.request('/api/graph/rebuild',operationOptions(args,first));assert.equal(start.status,202);await f.settle();
 const job=f.db.prepare('SELECT id,version FROM graph_jobs WHERE capture_id=?').get(capture);
 const response=await f.request('/api/graph/rebuild',operationOptions(args,duplicate));const data=await response.json();
 assert.equal(response.status,202);assert.equal(data.ai_operation.id,first);assert.ok(['running','queued'].includes(data.ai_operation.state));
 assert.equal(f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='graph' AND job_id=? AND generation=?").get(job.id,String(job.version)).operation_id,first);
 await cancel(f,duplicate);assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE id=?').get(job.id).state,'pending');
 await cancel(f,data.ai_operation.id);assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE id=?').get(job.id).state,'canceled');
 let calls=0;setProviderDouble(async()=>{calls++;throw Error('canceled graph must not invoke AI');});await drainWrapped(f);assert.equal(calls,0);
});

test('duplicate theme rebuilds preserve the canonical owner without incrementing its generation',{timeout:10000},async t=>{
 const f=await setup(t),first=crypto.randomUUID(),duplicate=crypto.randomUUID(),path='/api/themes/theme%3Awork/rebuild';
 const start=await f.request(path,operationOptions({version:1,idempotency_key:crypto.randomUUID()},first));const saved=await start.json();assert.equal(start.status,202,JSON.stringify(saved));await f.settle();
 const before={...f.db.prepare('SELECT id,version,state FROM theme_jobs WHERE id=?').get(saved.job_id)};
 const response=await f.request(path,operationOptions({version:1,idempotency_key:crypto.randomUUID()},duplicate));const data=await response.json();
 assert.equal(response.status,202);assert.equal(data.ai_operation.id,first);assert.ok(['running','queued'].includes(data.ai_operation.state));
 assert.deepEqual({...f.db.prepare('SELECT id,version,state FROM theme_jobs WHERE id=?').get(saved.job_id)},before);
 await cancel(f,duplicate);assert.equal(f.db.prepare('SELECT state FROM theme_jobs WHERE id=?').get(saved.job_id).state,'pending');
 await cancel(f,data.ai_operation.id);assert.equal(f.db.prepare('SELECT state FROM theme_jobs WHERE id=?').get(saved.job_id).state,'canceled');
});

test('a capture correction superseding an in-flight extraction fails the old operation without saving stale output',{timeout:10000},async t=>{
 const f=await setup(t),capture=await saveOriginal(f),op=crypto.randomUUID(),gate=deferred();let calls=0;
 setProviderDouble(async(...args)=>{calls++;await gate.promise;return mockAi(...args);});
 await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},op));await f.settle();
 const pending=deliver(f,f.messages.shift());await until(()=>calls===1);
 const correction=await f.request(`/api/captures/${capture}`,json('PATCH',{version:1,corrected_text:'供給能力だけでなく需要の変化も確認する。'}));assert.equal(correction.status,200);
 gate.resolve();await pending;
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests WHERE capture_id=?').get(capture).n,0);
 const current=f.db.prepare('SELECT version,corrected_text FROM captures WHERE id=?').get(capture);
 assert.equal(current.version,2);assert.equal(current.corrected_text,'供給能力だけでなく需要の変化も確認する。');
 assert.equal((await snapshot(f,op)).state,'failed');assert.equal(calls,1);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=? AND version=2').get(capture).state,'blocked');
});

test('a mixed overlapping graph rebuild rejects the whole request without starting or claiming its new capture',{timeout:10000},async t=>{
 const f=await setup(t),activeCapture=seedMaterial(f),newCapture=seedMaterial(f),owner=crypto.randomUUID(),overlap=crypto.randomUUID();
 const first=await f.request('/api/graph/rebuild',operationOptions({capture_ids:[activeCapture]},owner));assert.equal(first.status,202);await f.settle();
 const response=await f.request('/api/graph/rebuild',operationOptions({capture_ids:[activeCapture,newCapture]},overlap));const data=await response.json();
 assert.equal(response.status,409,JSON.stringify(data));await f.settle();
 assert.equal(f.db.prepare('SELECT count(*) n FROM graph_jobs WHERE capture_id=?').get(newCapture).n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM explicit_ai_actions WHERE kind='graph' AND target_id=?").get(newCapture).n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_operation_jobs WHERE operation_id=?').get(overlap).n,0);
 assert.equal(f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='graph'").get().operation_id,owner);
 assert.equal(f.messages.filter(message=>message.graph_job_id).length,1);
 await cancel(f,overlap);
 assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE capture_id=?').get(activeCapture).state,'pending');
 assert.ok(['running','queued'].includes((await snapshot(f,owner)).state));
});

test('legacy dispatch repairing an unrelated stale graph does not attach it to a newly saved capture operation',{timeout:10000},async t=>{
 const f=await setup(t);f.env.AI_EXECUTION_POLICY='automatic_legacy';
 const unrelated=seedMaterial(f),dependency=seedMaterial(f),graphJob=crypto.randomUUID(),generation=crypto.randomUUID(),op=crypto.randomUUID();
 f.db.prepare("INSERT INTO graph_generations(id,capture_id,version,active,result,model,processing_version,input_snapshot,created_at) VALUES(?,?,1,1,'{}','fixture','fixture','{}',0)").run(generation,unrelated);
 f.db.prepare('INSERT INTO graph_dependencies VALUES(?,?,0)').run(generation,dependency);
 f.db.prepare("INSERT INTO graph_jobs(id,capture_id,version,state,available_at,created_at) VALUES(?,?,1,'completed',0,0)").run(graphJob,unrelated);
 const options=operationOptions({text:'新しい資料の供給制約を保存する。'},op);options.headers['Idempotency-Key']=crypto.randomUUID();
 const response=await f.request('/api/captures',options);const saved=await response.json();assert.equal(response.status,201,JSON.stringify(saved));await f.settle();
 assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE id=?').get(graphJob).state,'pending','global dispatch must actually repair the stale graph');
 assert.ok(f.messages.some(message=>message.graph_job_id===graphJob));
 assert.equal(f.db.prepare("SELECT count(*) n FROM ai_operation_jobs WHERE kind='graph' AND job_id=?").get(graphJob).n,0,'unrelated maintenance is not a child of the new operation');
 await cancel(f,op);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(saved.id).state,'canceled');
 assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE id=?').get(graphJob).state,'pending');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_operation_fences').get().n,0);
});

test('an explicitly requested child extraction after completed research replaces its dormant terminal owner',{timeout:10000},async t=>{
 const f=await setup(t),researchOp=crypto.randomUUID(),extractOp=crypto.randomUUID();
 const options=operationOptions({question:'供給制約が価格に及ぼす条件は？'},researchOp);options.headers['Idempotency-Key']=crypto.randomUUID();
 const response=await f.request('/api/research',options),run=await response.json();assert.equal(response.status,202);await f.settle();
 const capture=await saveOriginal(f),job=f.db.prepare('SELECT id FROM jobs WHERE capture_id=?').get(capture).id,material=crypto.randomUUID(),url='https://www.boj.or.jp/fixture';
 const sourceText=f.db.prepare('SELECT original_text FROM captures WHERE id=?').get(capture).original_text;
 f.db.prepare('UPDATE research_runs SET urls_json=? WHERE id=?').run(JSON.stringify([url]),run.id);
 f.db.prepare("INSERT INTO research_materials(id,run_id,url,title,body,state,capture_id,retrieved_at) VALUES(?,?,?,'一次資料',?,'saved',?,0)").run(material,run.id,url,sourceText,capture);
 f.db.prepare("INSERT INTO ai_operation_jobs VALUES('capture',?,'1',?)").run(job,researchOp);
 let researchCalls=0,extractionCalls=0;
 setProviderDouble(async(providerUrl,init)=>{
  const payload=JSON.parse(init.body);
  if(payload.text?.format?.name!=='external_research_v1'){extractionCalls++;return mockAi(providerUrl,init);}
  researchCalls++;return graphResponse({},{summary:'原文に基づく検討',findings:[{text:'供給能力が価格に影響する。',stance:'qualifies',conditions:['供給不足の場合'],evidence:[{material_id:material,quote:sourceText}],event_at:null,subject_period:null}],gaps:[],next_reading:[]});
 });
 const researchMessage=f.messages.splice(0).find(message=>message.research_id===run.id);await deliver(f,researchMessage);
 assert.equal((await snapshot(f,researchOp)).state,'completed');
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE id=?').get(job).state,'blocked');
 const extraction=await f.request(`/api/captures/${capture}/extract`,operationOptions({version:1},extractOp));const accepted=await extraction.json();
 assert.equal(extraction.status,202,JSON.stringify(accepted));assert.equal(accepted.ai_operation.id,extractOp);
 assert.equal(f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='capture' AND job_id=?").get(job).operation_id,extractOp);
 await drainWrapped(f);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE id=?').get(job).state,'completed');
 assert.equal(f.db.prepare('SELECT count(*) n FROM harvests WHERE capture_id=?').get(capture).n,1);
 assert.equal((await snapshot(f,extractOp)).state,'completed');assert.equal((await snapshot(f,researchOp)).state,'completed');
 assert.equal(researchCalls,1);assert.equal(extractionCalls,1);
});

test('a completed legacy graph owner does not suppress one later automatic repair, but canceled owners stay stopped',{timeout:10000},async t=>{
 const {dispatchGraph}=await import('../src/graph.ts');
 const f=await setup(t);f.env.AI_EXECUTION_POLICY='automatic_legacy';
 const capture=seedMaterial(f),dependency=seedMaterial(f),job=crypto.randomUUID(),generation=crypto.randomUUID(),old=crypto.randomUUID();
 f.db.prepare("INSERT INTO graph_generations(id,capture_id,version,active,result,model,processing_version,input_snapshot,created_at) VALUES(?,?,1,1,'{}','fixture','fixture','{}',0)").run(generation,capture);
 f.db.prepare('INSERT INTO graph_dependencies VALUES(?,?,0)').run(generation,dependency);
 f.db.prepare("INSERT INTO graph_jobs(id,capture_id,version,state,available_at,created_at) VALUES(?,?,1,'completed',0,0)").run(job,capture);
 f.db.prepare("INSERT INTO ai_operations(id,path,label,mode,state,created_at,updated_at) VALUES(?,'/api/graph/rebuild','graph','queued','completed',0,0)").run(old);
 f.db.prepare("INSERT INTO ai_operation_jobs VALUES('graph',?,'1',?)").run(job,old);
 let calls=0;setProviderDouble(async(...args)=>{calls++;return mockAi(...args);});
 await dispatchGraph(f.env);const message=f.messages.splice(0).find(m=>m.graph_job_id===job);assert.ok(message);
 await deliver(f,message);
 assert.equal(calls,1);assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE id=?').get(job).state,'completed');
 assert.equal((await snapshot(f,old)).state,'completed');
 // Duplicate delivery after completion is inert; cancellation never gets this bypass.
 await deliver(f,message);assert.equal(calls,1);
 f.db.prepare("UPDATE ai_operations SET state='canceled' WHERE id=?").run(old);
 f.db.prepare("UPDATE graph_jobs SET state='pending',available_at=0 WHERE id=?").run(job);
 await deliver(f,message);
 assert.equal(calls,1);assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE id=?').get(job).state,'canceled');
});
