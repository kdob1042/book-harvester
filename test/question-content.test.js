import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json} from './helpers.js';
import {synthesisInput} from '../src/themes.ts';
import {questionContent} from '../src/question-context.ts';
test('content editing preserves snapshots, updates context and never starts AI',async t=>{
 const f=await fixture();t.after(f.close);await f.login();f.env.AI_EXECUTION_POLICY='explicit';
 const before=f.db.prepare('SELECT count(*) n FROM ai_calls').get().n;
 const edit=async(version,content)=>f.request('/api/themes/theme%3Awork',json('PATCH',{version,question:'AI時代の仕事',content}));
 let r=await edit(1,'  失業より仕事の再構成に注目したい  ');assert.equal(r.status,200);let value=await r.json();assert.equal(value.theme.content,'失業より仕事の再構成に注目したい');assert.equal(value.theme.version,2);
 assert.equal((await synthesisInput(f.env,'theme:work')).theme.content,value.theme.content);
 const snapshot=JSON.stringify({theme:value.theme});f.db.prepare("INSERT INTO theme_revisions(id,theme_id,version,result,input_snapshot,input_fingerprint,processing_version,model,changed,change_reason,created_at) VALUES('content-revision','theme:work',1,?,?,?,?,?,1,'fixture',0)").run(JSON.stringify({understanding:[],changes:[],competing:[],conditions:[],questions:[]}),snapshot,'fp','v1','fixture');f.db.prepare("INSERT INTO theme_syntheses VALUES('theme:work','content-revision',1)").run();
 assert.equal((await edit(1,'競合')).status,409);
 r=await edit(2,'  ');value=await r.json();assert.equal(value.theme.content,null);assert.equal(value.stale,true);
 assert.equal(JSON.parse(f.db.prepare("SELECT input_snapshot FROM theme_revisions WHERE id='content-revision'").get().input_snapshot).theme.content,'失業より仕事の再構成に注目したい');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,before);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_jobs').get().n,0);
});
test('content accepts null, rejects invalid values and oversized input',()=>{assert.equal(questionContent(null),null);assert.equal(questionContent(' \n '),null);assert.throws(()=>questionContent(3));assert.throws(()=>questionContent('a'.repeat(10001)));});
