import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json} from './helpers.js';

function theme(f,id,mergedInto=null){f.db.prepare("INSERT INTO themes(id,question,scope,exclusions,state,merged_into,created_by,created_at) VALUES(?,?,'','',?,?,'user',0)").run(id,id,mergedInto?'merged':'active',mergedInto);}
function edge(f,parent,child){f.db.prepare("INSERT INTO question_relations VALUES(?,?,'drilldown',0)").run(parent,child);}
function integration(f,parent,child){
 const revision=`revision:${parent}`;
 f.db.prepare("INSERT OR IGNORE INTO theme_revisions VALUES(?,?,1,'{}','{}','fixture','fixture','fixture',1,'fixture',0)").run(revision,parent);
 f.db.prepare('INSERT OR IGNORE INTO theme_syntheses VALUES(?,?,1)').run(parent,revision);
 f.db.prepare("INSERT INTO knowledge_inputs VALUES(?,?,'theme',?,1,'')").run(parent,revision,child);
}

test('delete recursively follows integration, drilldown and identities, including shared descendants',async t=>{
 const f=await fixture();t.after(f.close);await f.login();
 for(const id of ['child','grandchild','shared','other-parent','opposing','old-child'])theme(f,id,id==='old-child'?'child':null);
 integration(f,'theme:work','old-child');edge(f,'old-child','grandchild');edge(f,'grandchild','shared');edge(f,'other-parent','shared');
 f.db.prepare("INSERT INTO question_oppositions VALUES('opposing','theme:work','反対仮説',0)").run();
 f.db.prepare("INSERT INTO theme_jobs(id,kind,target_id,version,state,available_at,lease_token,created_at) VALUES('job','synthesis','grandchild',1,'running',0,'lease',0)").run();
 const captureOptions=json('POST',{text:'削除後も残す原資料'});captureOptions.headers['Idempotency-Key']=crypto.randomUUID();
 const captureResponse=await f.request('/api/captures',captureOptions);assert.equal(captureResponse.status,201);const capture=await captureResponse.json();
 const response=await f.request('/api/themes/theme%3Awork',json('DELETE',{version:1}));assert.equal(response.status,200,await response.clone().text());
 const deleted=(await response.json()).deleted_ids;assert.deepEqual(deleted.sort(),['theme:work','child','old-child','grandchild','shared'].sort());
 for(const id of deleted){assert.equal(f.db.prepare('SELECT state FROM themes WHERE id=?').get(id).state,'deleted');assert.equal((await f.request(`/api/themes/${encodeURIComponent(id)}`)).status,404);assert.equal(f.db.prepare("SELECT count(*) n FROM theme_history WHERE theme_id=? AND action='delete'").get(id).n,1);}
 for(const id of ['other-parent','opposing','theme:value'])assert.equal(f.db.prepare('SELECT state FROM themes WHERE id=?').get(id).state,'active');
 assert.equal(f.db.prepare('SELECT count(*) n FROM canonical_question_edges').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM question_oppositions').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_inputs').get().n,1,'retain historical integration evidence');
 assert.equal(f.db.prepare('SELECT state,lease_token FROM theme_jobs WHERE id=?').get('job').state,'cancelled');
 assert.equal((await f.request(`/api/captures/${capture.id}`)).status,200);
});

test('deleting a shared integrated child removes its live edge and keeps the other parent a root',async t=>{
 const f=await fixture();t.after(f.close);await f.login();integration(f,'theme:value','theme:work');
 assert.equal((await f.request('/api/themes/theme%3Awork',json('DELETE',{version:1}))).status,200);
 const index=await (await f.request('/api/themes')).json();assert.equal(index.branches.length,0);assert.equal(index.themes.find(x=>x.id==='theme:value').is_tip,1);
});

test('subtree changes before the transaction reject deletion without partial changes',async t=>{
 for(const change of ['child-version','new-child']){
  const f=await fixture();try{await f.login();theme(f,'child');theme(f,'new-child');edge(f,'theme:work','child');const batch=f.env.DB.batch;
   f.env.DB.batch=async statements=>{if(change==='child-version')f.db.prepare("UPDATE themes SET version=2 WHERE id='child'").run();else edge(f,'child','new-child');return batch(statements);};
   assert.equal((await f.request('/api/themes/theme%3Awork',json('DELETE',{version:1}))).status,409);
   assert.equal(f.db.prepare("SELECT count(*) n FROM themes WHERE state='deleted'").get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_history').get().n,0);
   assert.equal(f.db.prepare('SELECT count(*) n FROM question_relations').get().n,change==='new-child'?2:1);
  }finally{await f.close();}
 }
});

test('large subtrees and legacy cycles are deduplicated without SQL parameter limits',async t=>{
 const f=await fixture();t.after(f.close);await f.login();let parent='theme:work';
 for(let i=0;i<120;i++){const id=`child:${i}`;theme(f,id);edge(f,parent,id);parent=id;}edge(f,parent,'theme:work');
 const response=await f.request('/api/themes/theme%3Awork',json('DELETE',{version:1}));assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).deleted_ids.length,121);
 assert.equal(f.db.prepare("SELECT count(*) n FROM themes WHERE state='deleted'").get().n,121);assert.equal(f.db.prepare('SELECT count(*) n FROM question_relations').get().n,0);
});
