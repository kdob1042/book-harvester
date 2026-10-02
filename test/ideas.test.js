import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json,sentence,photo} from './helpers.js';

test('independent text keeps optional source without changing reading context, including replay and harvest',async t=>{
 const f=await fixture();t.after(f.close);await f.login();
 const book=crypto.randomUUID();f.db.prepare("INSERT INTO sources(id,title,certainty,created_at) VALUES(?,?,'explicit',?)").run(book,'読書中の本',Date.now());f.db.prepare("INSERT INTO settings(key,value) VALUES('current_source',?)").run(book);
 for(const [i,source] of ['', 'https://example.com/article?a=1&b=2', '別の本'].entries()){
  const options={...json('POST',{text:sentence,source}),headers:{'Content-Type':'application/json','Idempotency-Key':`ideas-source-request-${i}`}};
  const response=await f.request('/api/captures',options);assert.equal(response.status,201);const saved=await response.json();
  assert.equal((await f.request('/api/captures',options)).status,200);
  let c=await (await f.request(`/api/captures/${saved.id}`)).json();assert.equal(c.source_title,source||null);assert.equal(c.source_inherited,0);assert.equal(c.source_locked,1);assert.equal(c.import_origin,'user');
  await f.drain();c=await (await f.request(`/api/captures/${saved.id}`)).json();assert.equal(c.source_title,source||null);assert.equal(c.original_text,sentence);
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE key='current_source'").get().value,book);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM views').get().n,0);
  const changed=await f.request('/api/captures',{...options,body:JSON.stringify({text:sentence,source:'変更'})});assert.equal(changed.status,409);
 }
 const response=await f.request('/api/captures',{method:'POST',headers:{'Idempotency-Key':'ideas-next-photo-request'},body:photo()});const saved=await response.json();const c=await (await f.request(`/api/captures/${saved.id}`)).json();assert.equal(c.source_id,book);assert.equal(c.source_inherited,1);
 const exported=await (await f.request('/api/export')).json();assert.ok(exported.sources.some(s=>s.title==='https://example.com/article?a=1&b=2'));
});
test('fragment saves without metadata and unsafe URL schemes are rejected',async t=>{
 const f=await fixture();t.after(f.close);await f.login();
 for(const [i,source] of ['', 'javascript:alert(1)'].entries()){
  const response=await f.request('/api/captures',{...json('POST',{text:'集中？',source}),headers:{'Content-Type':'application/json','Idempotency-Key':`ideas-fragment-request-${i}`}});assert.equal(response.status,i?400:201);
 }
});
