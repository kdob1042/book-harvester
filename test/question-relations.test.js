import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,json,setProviderDouble} from './helpers.js';
import {suggestRelations,saveRelation,oppositionLinks,validateRelations} from '../src/question-relations.ts';
import {drilldown} from '../src/drilldown.ts';import {mergeTheme,readTheme} from '../src/themes.ts';
const provider=candidates=>async()=>Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({candidates})}]}]});
const candidate={type:'opposes',target_id:null,question:'AIは生産性を下げるか？',content:'確認コストが増える仮説',reason:'同じ仕事で効果が逆になる仮説'};
test('opposition adoption keeps both hypotheses, is symmetric and idempotent; drilldown sees both sides',async t=>{
 const f=await fixture();t.after(f.close);await f.login();setProviderDouble(provider([candidate]));t.after(()=>setProviderDouble(null));
 const before=f.db.prepare("SELECT * FROM themes WHERE id='theme:work'").get();const r=await f.request('/api/themes/theme%3Awork/relationships',json('POST',{version:1}));assert.equal(r.status,200);const run=await r.json();assert.equal((await oppositionLinks(f.env,'theme:work')).length,0);
 const save=()=>f.request('/api/themes/theme%3Awork/relationships/save',json('POST',{run_id:run.id,candidate_index:0}));const adopted=await(await save()).json();assert.equal((await(await save()).json()).id,adopted.id);
 assert.deepEqual(f.db.prepare("SELECT * FROM themes WHERE id='theme:work'").get(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM question_relations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_jobs').get().n,0);
 assert.equal((await oppositionLinks(f.env,adopted.id))[0].id,'theme:work');assert.equal((await readTheme(f.env,'theme:work')).oppositions[0].id,adopted.id);
 await assert.rejects(mergeTheme(f.env,'theme:work',{target_id:adopted.id,version:1,reason:'まとめる'}));
 await drilldown(f.env,'theme:work',{version:1},async(url,options)=>{const input=JSON.parse(JSON.parse(options.body).input);assert.equal(input.oppositions[0].theme.id,adopted.id);assert.ok(Array.isArray(input.oppositions[0].claims));return provider([{question:'確認コストを含めるとどうなるか？',content:'',reason:'比較'},{question:'どの仕事で逆転するか？',content:'',reason:'条件'}])();});
 assert.equal((await f.request('/api/themes/theme%3Awork/relationships/remove',json('POST',{target_id:adopted.id}))).status,200);assert.equal((await oppositionLinks(f.env,adopted.id)).length,0);assert.ok(f.db.prepare('SELECT 1 FROM themes WHERE id=?').get(adopted.id));
});
test('stale proposals and invalid identities are rejected; vertical cycles are prevented',async t=>{
 const f=await fixture();t.after(f.close);const pool=f.db.prepare("SELECT * FROM themes WHERE id<>'theme:work'").all();const target=pool[0];
 assert.throws(()=>validateRelations({candidates:[{...candidate,target_id:'missing'}]},'theme:work',pool));assert.throws(()=>validateRelations({candidates:[{...candidate,type:'upstream'}]},'theme:work',pool));
 const run=await suggestRelations(f.env,'theme:work',{version:1},provider([{...candidate,type:'downstream',target_id:target.id}]));f.db.prepare('UPDATE themes SET version=version+1 WHERE id=?').run(target.id);await assert.rejects(saveRelation(f.env,'theme:work',{run_id:run.id,candidate_index:0}));
 f.db.prepare("INSERT INTO question_relations VALUES(?,?,'drilldown',0)").run(target.id,'theme:work');const cycle=await suggestRelations(f.env,'theme:work',{version:1},provider([{...candidate,type:'downstream',target_id:target.id}]));await assert.rejects(saveRelation(f.env,'theme:work',{run_id:cycle.id,candidate_index:0}));
 const stale=await suggestRelations(f.env,'theme:work',{version:1},provider([candidate]));f.db.prepare("UPDATE themes SET version=2 WHERE id='theme:work'").run();await assert.rejects(saveRelation(f.env,'theme:work',{run_id:stale.id,candidate_index:0}));
});

test('identity preserves opposing links and rejects collapsing opponents',async t=>{
 const f=await fixture();t.after(f.close);const {identityStatements}=await import('../src/question-identity.ts');
 for(const [id,q] of [['theme:duplicate','同じ問い'],['theme:opponent','逆の仮説']])f.db.prepare("INSERT INTO themes(id,question,scope,exclusions,created_by,created_at) VALUES(?,?,'','','user',0)").run(id,q);
 f.db.prepare("INSERT INTO question_oppositions VALUES('theme:duplicate','theme:opponent','対立',0)").run();
 await f.env.DB.batch(await identityStatements(f.env,'theme:work',['theme:duplicate'],'1',[]));
 assert.equal((await oppositionLinks(f.env,'theme:work'))[0].id,'theme:opponent');assert.equal((await oppositionLinks(f.env,'theme:opponent'))[0].id,'theme:work');
 await assert.rejects(identityStatements(f.env,'theme:work',['theme:opponent'],'1',[]),/対立/);
 const {removeOpposition}=await import('../src/question-relations.ts');await removeOpposition(f.env,'theme:work',{target_id:'theme:opponent'});assert.equal((await oppositionLinks(f.env,'theme:opponent')).length,0);
});
