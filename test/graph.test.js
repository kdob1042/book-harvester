import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json,photo,graphResult,graphResponse,result} from './helpers.js';
import {dispatch} from '../src/queue.ts';
import {processGraphJob} from '../src/graph.ts';
import {validateGraph} from '../src/graph-contract.js';

import {a,b,viewA,material,semanticMock} from './graph-fixtures.js';
async function save(f,sentence,index){
 const r=await f.request('/api/captures',{...json('POST',{text:sentence}),headers:{'Content-Type':'application/json','Idempotency-Key':`graph-fixture-${index}-unique`}});assert.equal(r.status,201);return (await r.json()).id;
}
async function detail(f,id){return (await f.request(`/api/captures/${id}`)).json();}
async function prepare(t){const f=await fixture();t.after(f.close);await f.login();const first=await save(f,a,1);await f.drain(semanticMock);const adopted=await (await f.request(`/api/captures/${first}/adopt`,json('POST',{version:1}))).json();const second=await save(f,b,2);await f.drain(semanticMock);return {f,first,second,viewId:adopted.id};}

test('graph grows without approval; cross-book comparison has both sources, partial proposal adoption preserves other paragraphs',async t=>{
 const {f,first,second,viewId}=await prepare(t);
 assert.equal(f.db.prepare('SELECT count(*) n FROM current_graph_nodes').get().n,6);
 assert.equal(f.db.prepare('SELECT count(*) n FROM current_graph_relations').get().n,3);
 let v=await (await f.request(`/api/views/${viewId}`)).json();assert.equal(v.version,1);assert.equal(v.body,viewA);
 const c=await detail(f,second);assert.equal(c.graph.discoveries.length,1);assert.equal(c.graph.proposal.base_version,1);
 assert.deepEqual(new Set(c.graph.discoveries[0].relation.evidence.map(e=>e.capture_id)),new Set([first,second]));
 assert.equal((await f.request(`/api/captures/${second}/proposal`,json('POST',{version:1,proposal_id:c.graph.proposal.id}))).status,201);
 const repeated=await f.request(`/api/captures/${second}/proposal`,json('POST',{version:1,proposal_id:c.graph.proposal.id}));assert.equal(repeated.status,200);
 v=await (await f.request(`/api/views/${viewId}`)).json();assert.equal(v.version,2);assert.ok(v.body.endsWith('景気の見方は変えない。'));assert.equal(v.revisions.length,2);assert.equal(v.revisions[1].body,viewA);assert.equal(v.revisions[0].references.evidence.length,2);
 assert.equal((await (await f.request('/api/state?q=analogous_to')).json()).captures[0].id,second);
 const exported=await (await f.request('/api/export')).json();assert.equal(exported.graph_nodes.length,6);assert.equal(exported.graph_relations.length,3);assert.equal(exported.view_proposals[0].status,'adopted');assert.ok(exported.graph_generations[0].input_snapshot.current.harvest);
});

test('same labels with different meanings stay separate; different vocabulary can be semantically reused with a recorded reason',async t=>{
 const f=await fixture();t.after(f.close);await f.login();
 let count=0;
 const mock=async(url,opts)=>{const p=JSON.parse(opts.body);if(p.text.format.name==='capture_harvest_v1'){const h=material(a,`資料${++count}`);h.concepts[0]={id:'k1',name:count<3?'資本':'投資の元手',description:count===2?'社会的関係によって得られる資源':'設備投資のための資金',claim_ids:['c1']};return graphResponse({},h);}
 const input=JSON.parse(p.input),out=graphResult(input);if(count===3){const same=input.candidates.nodes.find(n=>n.kind==='concept'&&n.payload.description==='設備投資のための資金');out.concept_resolution[0]={concept_id:'k1',existing_id:same.canonical_id,decision:'same_meaning',reason:'名称は異なるが設備投資に用いる資金という意味が同じ。',aliases:['投資の元手']};}return graphResponse(input,out);};
 for(let i=1;i<=3;i++){await save(f,a,i);await f.drain(mock);}
 const mentions=f.db.prepare('SELECT * FROM concept_mentions ORDER BY rowid').all();assert.notEqual(mentions[0].concept_id,mentions[1].concept_id);assert.equal(mentions[0].concept_id,mentions[2].concept_id);assert.equal(mentions[2].decision,'same_meaning');assert.equal(f.db.prepare('SELECT count(*) n FROM concepts').get().n,2);
});

test('stale View proposal is compared again and never overwrites a concurrent manual edit',async t=>{
 const {f,second,viewId}=await prepare(t);const c=await detail(f,second);
 await f.request(`/api/views/${viewId}`,json('PATCH',{version:1,body:viewA+'\n自分で追記した条件。',reason:'本人の訂正'}));
 assert.equal((await f.request(`/api/captures/${second}/proposal`,json('POST',{version:1,proposal_id:c.graph.proposal.id}))).status,409);
 await f.drain(semanticMock);const fresh=await detail(f,second);assert.equal(fresh.graph.proposal.base_version,2);
 await f.request(`/api/captures/${second}/proposal`,json('POST',{version:1,proposal_id:fresh.graph.proposal.id}));
 const v=await (await f.request(`/api/views/${viewId}`)).json();assert.equal(v.version,3);assert.ok(v.body.endsWith('自分で追記した条件。'));
});

test('correction invalidates cross-source discoveries immediately; deleted sources do not reappear after rebuild',async t=>{
 const {f,first,second,viewId}=await prepare(t);const c=await detail(f,second);await f.request(`/api/captures/${second}/proposal`,json('POST',{version:1,proposal_id:c.graph.proposal.id}));
 await f.request(`/api/captures/${first}`,json('PATCH',{version:1,corrected_text:'設備の話ではなく植物の記録。'}));
 assert.equal((await detail(f,second)).graph.discoveries.length,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM current_graph_nodes WHERE kind='claim' AND capture_id=?").get(second).n,1);
 const impacted=await (await f.request(`/api/views/${viewId}`)).json();assert.ok(impacted.evidence_issues.some(x=>x.capture_id===first));assert.equal(impacted.version,2);
 // Source deletion does not remove or rewrite adopted text; its stored evidence is marked unavailable.
 await f.request(`/api/captures/${first}`,json('DELETE',{version:2}));
 await f.request('/api/graph/rebuild',json('POST',{capture_ids:[first,second]}));await f.drain(semanticMock);
 const remaining=await (await f.request(`/api/views/${viewId}`)).json();assert.equal(remaining.version,2);assert.ok(remaining.evidence_issues.some(x=>x.state==='deleted'));
 assert.equal((await f.request(`/api/captures/${first}`)).status,404);assert.equal((await detail(f,second)).graph.discoveries.length,0);
});

test('failed rebuild preserves current generation; successful resend is idempotent and hidden findings persist',async t=>{
 const {f,second}=await prepare(t);let c=await detail(f,second),generation=c.graph.generation_id;
 await f.request(`/api/captures/${second}/hide`,json('POST',{version:1,item_key:`discovery:${c.graph.discoveries[0].text}`}));
 await f.request('/api/graph/rebuild',json('POST',{capture_ids:[second]}));await f.drain(async(url,opts)=>{if(JSON.parse(opts.body).text.format.name==='knowledge_graph_v1')return graphResponse({},{});return semanticMock(url,opts);});
 c=await detail(f,second);assert.equal(c.graph.generation_id,generation);assert.equal(c.graph.discoveries.length,0);assert.equal(c.graph.job.state,'failed');
 await f.request('/api/graph/rebuild',json('POST',{capture_ids:[second]}));await f.drain(semanticMock);c=await detail(f,second);assert.notEqual(c.graph.generation_id,generation);assert.equal(c.graph.discoveries.length,0);
 const job=f.db.prepare('SELECT id FROM graph_jobs WHERE capture_id=?').get(second);const count=f.db.prepare('SELECT count(*) n FROM graph_generations').get().n;await processGraphJob(f.env,job.id,semanticMock);assert.equal(f.db.prepare('SELECT count(*) n FROM graph_generations').get().n,count);assert.equal(f.db.prepare('SELECT count(*) n FROM current_graph_nodes').get().n,6);
});

test('graph validation rejects invented edges, unrelated evidence, unsupported causality and disconnected mechanisms',()=>{
 const h=material(a,'本A'),input={current:{harvest:h},candidates:{nodes:[],views:[]}},out=graphResult(input);assert.doesNotThrow(()=>validateGraph(out,h,input.candidates));
 const clone=()=>structuredClone(out);
 let bad=clone();bad.relations[0].to_id='missing';assert.throws(()=>validateGraph(bad,h,input.candidates));
 bad=clone();bad.relations[0].evidence[0].quote='捏造';assert.throws(()=>validateGraph(bad,h,input.candidates));
 bad=clone();bad.relations[0].type='causes';assert.throws(()=>validateGraph(bad,h,input.candidates));
 const chain=material(a,'本A');chain.claims.push({id:'c2',text:a,conditions:['条件'],evidence:chain.claims[0].evidence});chain.concepts.push({id:'k2',name:'初期投資',description:'利用者の費用',claim_ids:['c1','c2']},{id:'k3',name:'参入',description:'利用者の開始',claim_ids:['c2']});
 const valid=graphResult({current:{harvest:chain}});valid.relations=[{id:'r1',from_id:'k1',to_id:'k2',type:'reduces',reason:'資料の説明',conditions:['外部利用'],interpretation:'source_explanation',evidence:[{claim_id:'c1',quote:a}]},{id:'r2',from_id:'k2',to_id:'k3',type:'enables',reason:'資料の条件付き推論',conditions:['費用を負担できる'],interpretation:'ai_hypothesis',evidence:[{claim_id:'c2',quote:a}]}];valid.mechanisms=[{id:'m1',text:'外部利用→投資負担軽減→参入を可能にする',claim_ids:['c1','c2'],relation_ids:['r1','r2'],conditions:['外部利用が成立する'],time_lag:null}];assert.doesNotThrow(()=>validateGraph(valid,chain,input.candidates));
 bad=structuredClone(valid);bad.mechanisms[0].relation_ids.reverse();assert.throws(()=>validateGraph(bad,chain,input.candidates));
});

test('unrelated records yield no forced discovery and graph queue failure leaves harvest readable',async t=>{
 const f=await fixture();t.after(f.close);await f.login();await save(f,a,1);await f.drain(semanticMock);const unrelated=await save(f,'植物の葉の記録。',2);await f.drain(semanticMock);assert.equal((await detail(f,unrelated)).graph.discoveries.length,0);
 const third=await save(f,b,3);await f.settle();const job=f.messages.shift();const {processJob}=await import('../src/queue.ts');await processJob(f.env,job.job_id,semanticMock);f.messages.length=0;f.env.HARVEST_QUEUE.send=async()=>{throw Error('queue down');};f.db.prepare('UPDATE graph_jobs SET dispatched_at=NULL WHERE capture_id=?').run(third);await dispatch(f.env);assert.equal((await detail(f,third)).job.state,'completed');assert.equal((await detail(f,third)).graph.job.state,'pending');
 f.env.HARVEST_QUEUE.send=async m=>f.messages.push(m);await dispatch(f.env);await f.drain(semanticMock);assert.equal((await detail(f,third)).graph.job.state,'completed');
});

test('in-flight cross-book generation cannot commit a source version that changed during the API call',async t=>{
 const {f,first,second,viewId}=await prepare(t),before=f.db.prepare('SELECT count(*) n FROM graph_generations').get().n;
 await f.request('/api/graph/rebuild',json('POST',{capture_ids:[second]}));await f.settle();const queued=f.messages.shift();
 let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
 const processing=processGraphJob(f.env,queued.graph_job_id,async(...args)=>{entered();await gate;return semanticMock(...args);});await start;
 await f.request(`/api/captures/${first}`,json('PATCH',{version:1,corrected_text:'資料を訂正した。'}));release();await processing;
 assert.equal(f.db.prepare('SELECT count(*) n FROM graph_generations').get().n,before);assert.equal((await detail(f,second)).graph.discoveries.length,0);
 assert.equal((await (await f.request(`/api/views/${viewId}`)).json()).body,viewA);
 assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE capture_id=?').get(second).state,'pending');
});

test('schema upgrade preserves preexisting adopted text and revision snapshots after source deletion',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{readFile}=await import('node:fs/promises'),db=new DatabaseSync(':memory:');
 try{db.exec(await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO captures(id,request_key,request_hash,kind,original_text,mutation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('old-capture','old-request','hash','text',a,'mutation',1,1);
  db.prepare('INSERT INTO views(id,capture_id,draft_key,title,body,version,created_at) VALUES(?,?,?,?,?,?,?)').run('old-view','old-capture','old-draft','見方',viewA,1,1);
  db.prepare('INSERT INTO view_revisions(view_id,version,body,reason,references_json,created_at) VALUES(?,?,?,?,?,?)').run('old-view',1,viewA,'本人採用','{"capture_id":"old-capture","capture_version":1}',1);
  db.exec(await readFile(new URL('../migrations/0002_knowledge_graph.sql',import.meta.url),'utf8'));db.prepare('DELETE FROM captures WHERE id=?').run('old-capture');
  assert.equal(db.prepare('SELECT body FROM views').get().body,viewA);assert.equal(db.prepare('SELECT references_json FROM view_revisions').get().references_json,'{"capture_id":"old-capture","capture_version":1}');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('grounded conditional mechanism is stored with normalized claim and relation references',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const second='初期投資が下がると、条件次第で新規利用者が参加しやすくなる。',h=material(a+'\n'+second,'連鎖の本');h.claims[0].text=a;h.claims[0].evidence.quote=a;h.claims.push({id:'c2',text:second,conditions:['投資額が参加の制約になっている場合'],evidence:{origin:'source',quote:second,locator:'p.1',certainty:'explicit'}});h.concepts[0]={id:'k1',name:'外部利用',description:'共通設備を借りる',claim_ids:['c1']};h.concepts.push({id:'k2',name:'初期投資',description:'利用者の初期費用',claim_ids:['c1','c2']},{id:'k3',name:'参加',description:'新しい利用者による開始',claim_ids:['c2']});
 const cap=await save(f,h.extracted_text,1);await f.drain(async(url,opts)=>{const p=JSON.parse(opts.body);if(p.text.format.name==='capture_harvest_v1')return graphResponse({},h);const input=JSON.parse(p.input),out=graphResult(input);out.relations=[{id:'r1',from_id:'k1',to_id:'k2',type:'reduces',reason:'Aの資料の説明',conditions:['外部利用が可能'],interpretation:'source_explanation',evidence:[{claim_id:'c1',quote:a}]},{id:'r2',from_id:'k2',to_id:'k3',type:'constrains',reason:'初期費用が参加の制約になる',conditions:['投資額が参加の制約'],interpretation:'source_explanation',evidence:[{claim_id:'c2',quote:second}]}];out.mechanisms=[{id:'m1',text:'外部利用で初期投資が下がり、参加への制約が緩む。',claim_ids:['c1','c2'],relation_ids:['r1','r2'],conditions:['外部利用が可能で、費用が参加を制約している場合'],time_lag:null}];return graphResponse(input,out);});
 const c=await detail(f,cap);assert.equal(c.graph.mechanisms.length,1);const node=f.db.prepare("SELECT * FROM current_graph_nodes WHERE kind='mechanism'").get(),payload=JSON.parse(node.payload);assert.deepEqual(payload.claim_ids,[`${cap}:1:c1`,`${cap}:1:c2`]);assert.ok(payload.relation_ids.every(r=>f.db.prepare('SELECT id FROM current_graph_relations WHERE id=?').get(r)));assert.equal(payload.time_lag,null);
});

test('an edit racing between proposal reads and its transaction cannot falsely mark the proposal adopted',async t=>{
 const {f,second,viewId}=await prepare(t),c=await detail(f,second),batch=f.env.DB.batch;
 f.env.DB.batch=async statements=>{if(statements[0].sql.includes('INSERT INTO view_revisions')&&statements[0].sql.includes('current_graph_generations')){
  f.db.prepare('INSERT INTO view_revisions(view_id,version,body,reason,references_json,created_at) SELECT view_id,2,?, ?,references_json,2 FROM view_revisions WHERE view_id=? AND version=1').run('本人の同時編集','本人訂正',viewId);
  f.db.prepare('UPDATE views SET body=?,version=2 WHERE id=?').run('本人の同時編集',viewId);
 }return batch(statements);};
 assert.equal((await f.request(`/api/captures/${second}/proposal`,json('POST',{version:1,proposal_id:c.graph.proposal.id}))).status,409);
 assert.equal(f.db.prepare('SELECT status FROM view_proposals WHERE id=?').get(c.graph.proposal.id).status,'pending');assert.equal(f.db.prepare('SELECT body FROM views WHERE id=?').get(viewId).body,'本人の同時編集');assert.equal(f.db.prepare("SELECT count(*) n FROM graph_overrides WHERE action='adopted'").get().n,0);
});
