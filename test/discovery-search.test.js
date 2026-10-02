import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,result,graphResponse} from './helpers.js';
import {discoverRecords} from '../src/discovery.ts';
import {combineDiscovery} from '../src/discovery-search.ts';

function insert(f,id,text) {
 const h=result();h.summary=h.extracted_text=text;h.claims=[];h.concepts=[];h.questions=[];
 h.classification={domain_ids:['care'],lens_ids:[]};
 f.db.prepare(`INSERT INTO captures(id,kind,original_text,note,version,created_at,updated_at,mutation_id,request_key,request_hash)
  VALUES(?,'text',?,'',1,0,0,?,?,'hash')`).run(id,text,id,id);
 f.db.prepare('INSERT INTO harvests(capture_id,version,result,created_at) VALUES(?,1,?,0)').run(id,JSON.stringify(h));
}

test('AI-expanded search recalls old cross-domain material despite a saturated lexical shortlist; replay calls no AI', async t => {
 const f=await fixture();t.after(f.close);
 const title='推論の効率化で総消費電力は減るか？';
 f.db.prepare("INSERT INTO themes(id,question,content,scope,exclusions,created_by,created_at) VALUES('theme:efficiency',?,?,'計算資源','','user',0)")
  .run(title,'単価が下がると利用量が増える。総量の変化を確かめたい。');
 for(let i=0;i<80;i++)insert(f,`noise:${i}`,title+' 推論の効率化 消費電力');
 insert(f,'old:analogy','乗用車の燃費向上が走行距離を増やし、節約を打ち消す場合がある。');
 insert(f,'hidden:analogy','乗用車の燃費向上と走行距離');
 f.db.prepare("INSERT INTO capture_visibility VALUES('hidden:analogy',1,0)").run();
 let calls=0;
 const ai=async(_,options)=>{
  calls++;const p=JSON.parse(options.body),input=JSON.parse(p.input);
  if(p.text.format.name==='discovery_search_plan_v1')return graphResponse({},{queries:[{kind:'analogy',terms:['燃費','走行距離']}]});
  assert.ok(input.candidates.some(c=>c.id==='old:analogy' && c.search_direction==='analogy'));
  assert.ok(!input.candidates.some(c=>c.id==='hidden:analogy'));
  assert.ok(input.candidates.length<=30);
  return graphResponse({},{candidates:[{id:'old:analogy',relation:'analogy',relevance:3,
   reason:'単価低下が利用増を通じて節約を相殺する仮説を比較できる。交通需要と推論需要の違いは未検証。'}],
   destination:{theme_id:'theme:efficiency',question:title,content:null,scope:'計算資源',exclusions:''}});
 };
 const args={id:'theme:efficiency',version:1,idempotency_key:'guided-discovery-1'};
 const found=await discoverRecords(f.env,args,ai);
 assert.equal(found.candidates[0].id,'old:analogy');assert.equal(calls,2);
 assert.equal(found.selection.search_plan[0].kind,'analogy');
 await discoverRecords(f.env,args,ai);assert.equal(calls,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,0);
});

test('invalid search plans fail visibly before relation judgment and stay idempotent', async t => {
 const f=await fixture();t.after(f.close);let calls=0;
 const args={id:'theme:work',version:1,idempotency_key:'invalid-search-plan'};
 await assert.rejects(discoverRecords(f.env,args,async()=>{calls++;return graphResponse({},{queries:[{kind:'execute_sql',terms:['DROP TABLE themes']}]});}),/invalid_search_plan/);
 const replay=await discoverRecords(f.env,args,()=>{throw Error('must not retry automatically');});
 assert.equal(replay.state,'failed');assert.equal(calls,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM themes').get().n,6);
});

test('expanded directions each get space; fingerprints and the anchor cannot duplicate', () => {
 const m=(id)=>({id,fingerprint:id});
 const candidates=combineDiscovery(m('anchor'),
  ['cause','effect','counterexample','analogy'].map(kind=>[m('anchor'),m('same'),m(kind)]));
 assert.equal(candidates.length,5);
 for(const id of ['cause','effect','counterexample','analogy'])assert.ok(candidates.some(c=>c.id===id));
 assert.equal(candidates.filter(c=>c.id==='same').length,1);
 assert.ok(!candidates.some(c=>c.id==='anchor'));
});


test('AI compares more than ten retrieved records but returns at most ten, without baseline candidates', async t => {
 const f=await fixture();t.after(f.close);
 for(let n=0;n<24;n++)insert(f,`hit:${n}`,'燃費向上と走行距離の増加 '+n);
 insert(f,'baseline-only','専門性の価値は仕事で変わる');
 const found=await discoverRecords(f.env,{id:'theme:work',version:1,idempotency_key:'ai-only-ranking'},async(_,options)=>{
  const p=JSON.parse(options.body),input=JSON.parse(p.input);
  if(p.text.format.name==='discovery_search_plan_v1')return graphResponse({},{queries:[{kind:'analogy',terms:['燃費']}]});
  assert.ok(input.candidates.length>10);assert.ok(input.candidates.length<=30);
  assert.ok(!input.candidates.some(c=>c.id==='baseline-only'));
  assert.equal(p.text.format.schema.properties.candidates.maxItems,10);
  return graphResponse({},{candidates:input.candidates.slice(-10).map(c=>({id:c.id,reason:'単価と需要の条件を比較',relation:'analogy',relevance:3})),
   destination:{theme_id:'theme:work',question:input.anchor.title,content:null,scope:'仕事',exclusions:''}});
 });
 assert.equal(found.candidates.length,10);assert.equal(found.selection.result_limit,10);
});

test('empty AI search plan yields no candidates instead of falling back to classification search', async t => {
 const f=await fixture();t.after(f.close);insert(f,'related','専門性の価値は仕事で変わる');
 const found=await discoverRecords(f.env,{id:'theme:work',version:1,idempotency_key:'empty-ai-search'},async(_,options)=>{
  const p=JSON.parse(options.body),input=JSON.parse(p.input);
  if(p.text.format.name==='discovery_search_plan_v1')return graphResponse({},{queries:[]});
  assert.deepEqual(input.candidates,[]);
  return graphResponse({},{candidates:[],destination:{theme_id:'theme:work',question:input.anchor.title,content:null,scope:'仕事',exclusions:''}});
 });
 assert.deepEqual(found.candidates,[]);
});


test('legacy mode skips AI search planning, preserves legacy retrieval, and replays without AI', async t => {
 const f=await fixture();t.after(f.close);insert(f,'legacy-hit','専門性の価値は仕事で変わる');let calls=0;
 const args={id:'theme:work',version:1,search_mode:'legacy',idempotency_key:'legacy-mode'};
 const run=await discoverRecords(f.env,args,async(_,options)=>{
  calls++;const p=JSON.parse(options.body),input=JSON.parse(p.input);
  assert.equal(p.text.format.name,'related_discovery_v1');
  assert.equal(input.selection.search_mode,'legacy');
  assert.ok(input.candidates.some(c=>c.id==='legacy-hit'));
  return graphResponse({},{candidates:[{id:'legacy-hit',reason:'職種と専門性の条件を比較',relation:'condition',relevance:3}],destination:{theme_id:'theme:work',question:input.anchor.title,content:null,scope:'仕事',exclusions:''}});
 });
 assert.equal(calls,1);assert.equal(run.selection.search_mode,'legacy');
 await discoverRecords(f.env,args,()=>{throw Error('must not call AI');});assert.equal(calls,1);
 await assert.rejects(discoverRecords(f.env,{...args,search_mode:'unknown',idempotency_key:'invalid-mode'},()=>{throw Error('must not call AI');}),/検索方法/);
});
