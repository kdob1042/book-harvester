import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,json,setProviderDouble} from './helpers.js';import {drilldown,validateDrilldown} from '../src/drilldown.ts';import {listThemes,readTheme} from '../src/themes.ts';
const output={candidates:[{question:'職種によって効果は違うか？',content:'裁量の違いを確かめたい',reason:'条件を切り分ける'},{question:'追加業務が増えるのはなぜか？',content:'',reason:'仕組みを確認する'}]};
const provider=async(url,options)=>{const body=JSON.parse(options.body),input=JSON.parse(body.input);assert.equal(body.text.format.name,'question_drilldown_v1');assert.equal(input.theme.content,'時間の使い方に注目');assert.equal(input.direction,'条件');return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]});};
test('explicit drilldown creates ordinary child questions without rewriting or automatic AI',async t=>{
 const f=await fixture();t.after(f.close);await f.login();f.env.AI_EXECUTION_POLICY='explicit';f.db.prepare("UPDATE themes SET content='時間の使い方に注目' WHERE id='theme:work'").run();const before=f.db.prepare("SELECT * FROM themes WHERE id='theme:work'").get();
 setProviderDouble(provider);t.after(()=>setProviderDouble(null));
 const r=await f.request('/api/themes/theme%3Awork/drilldown',json('POST',{version:1,direction:'条件'}));assert.equal(r.status,200);const run=await r.json();assert.equal(run.candidates.length,2);assert.equal(f.db.prepare('SELECT count(*) n FROM themes').get().n,6);
 const save=()=>f.request('/api/themes/theme%3Awork/drilldown/save',json('POST',{run_id:run.id,candidate_index:0}));const saved=await (await save()).json();assert.equal((await (await save()).json()).id,saved.id);assert.equal(f.db.prepare('SELECT count(*) n FROM question_relations').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,1);
 assert.deepEqual(f.db.prepare("SELECT * FROM themes WHERE id='theme:work'").get(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM integration_runs').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_jobs').get().n,0);
 const detail=await readTheme(f.env,saved.id);assert.equal(detail.drilldown_parents[0].id,'theme:work');assert.equal(detail.theme.state,'active');assert.equal(detail.theme.content,output.candidates[0].content);
 const index=await listThemes(f.env);assert.equal(index.themes.find(x=>x.id===saved.id).is_tip,0);assert.ok(index.branches.some(x=>x.child_id===saved.id));
 await drilldown(f.env,saved.id,{version:1},async()=>Response.json({output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]}));assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,2);
 f.db.prepare("UPDATE themes SET version=2 WHERE id='theme:work'").run();assert.equal((await f.request('/api/themes/theme%3Awork/drilldown/save',json('POST',{run_id:run.id,candidate_index:1}))).status,409);
});
test('reject malformed candidates and stale parent before AI',async t=>{assert.throws(()=>validateDrilldown({candidates:[]}));assert.throws(()=>validateDrilldown({candidates:[{},{}]}));const f=await fixture();t.after(f.close);await assert.rejects(drilldown(f.env,'theme:work',{version:9}));assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,0);});
test('opposing context, editable candidates and shared child preserve both hypotheses',async t=>{
 const f=await fixture();t.after(f.close);await f.login();
 const other=f.db.prepare("SELECT id FROM themes WHERE id<>'theme:work' AND state='active' LIMIT 1").get().id;
 const pair=['theme:work',other].sort();f.db.prepare('INSERT INTO question_oppositions VALUES(?,?,?,?)').run(...pair,'同じ条件の対立',1);
 const result={candidates:[{question:'共通の条件は？',content:'期間を比較',reason:'境界を確認',target:'both',opposite_id:other},{question:'反対側の根拠は？',content:'',reason:'検証',target:'opposite',opposite_id:other}]};
 const run=await drilldown(f.env,'theme:work',{version:1},async(_,options)=>{const input=JSON.parse(JSON.parse(options.body).input);assert.equal(input.oppositions[0].theme.id,other);assert.ok(input.oppositions[0].materials);assert.ok(input.existing_children.drilldown_parents);return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify(result)}]}]});});
 const save=await f.request('/api/themes/theme%3Awork/drilldown/save',json('POST',{run_id:run.id,candidate_index:0,candidate:{...result.candidates[0],question:'編集した共通問い'}}));assert.equal(save.status,200);const child=await save.json();
 assert.equal(f.db.prepare('SELECT question FROM themes WHERE id=?').get(child.id).question,'編集した共通問い');assert.equal(f.db.prepare('SELECT count(*) n FROM question_relations WHERE child_id=?').get(child.id).n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM question_oppositions').get().n,1);
 const bad=await f.request('/api/themes/theme%3Awork/drilldown/save',json('POST',{run_id:run.id,candidate_index:1,candidate:{...result.candidates[1],opposite_id:'unknown'}}));assert.equal(bad.status,400);
 f.db.prepare('DELETE FROM question_oppositions').run();assert.equal((await f.request('/api/themes/theme%3Awork/drilldown/save',json('POST',{run_id:run.id,candidate_index:1}))).status,409);
});
