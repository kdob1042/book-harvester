import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,result} from './helpers.js';
import {capturePages} from '../src/knowledge-materials.ts';

test('legacy materials retain domain and lens classification across batched pages', async t => {
 const f = await fixture();t.after(f.close);
 const h = result();h.extracted_text = h.summary = '制作後の検証が制約となる';
 for (let i = 0; i < 401; i++) {
  const id = `legacy:${String(i).padStart(4,'0')}`;
  f.db.prepare(`INSERT INTO captures(id,kind,original_text,note,version,created_at,updated_at,mutation_id,request_key,request_hash)
   VALUES(?,'text',?,'',1,0,0,?,?,'hash')`).run(id,h.summary,id,id);
  f.db.prepare('INSERT INTO harvests(capture_id,version,result,created_at) VALUES(?,1,?,0)').run(id,JSON.stringify(h));
  f.db.prepare("INSERT INTO theme_memberships VALUES('theme:work',?,1,'[]','比較','condition',?,'v1',0)").run(id,id);
  f.db.prepare("INSERT INTO theme_member_lenses VALUES('theme:work',?,'constraint')").run(id);
 }
 f.db.prepare("INSERT INTO capture_visibility VALUES('legacy:0400',1,0)").run();
 let queries = 0;
 const prepare = f.env.DB.prepare.bind(f.env.DB);
 f.env.DB.prepare = sql => {queries++;return prepare(sql);};
 const materials = [];
 for await (const page of capturePages(f.env)) materials.push(...page);
 assert.equal(materials.length,400);
 assert.deepEqual(materials[0].domain_ids,['work']);
 assert.deepEqual(materials[399].lens_ids,['constraint']);
 assert.ok(queries < 12, `Legacy material scan made ${queries} queries`);
});
