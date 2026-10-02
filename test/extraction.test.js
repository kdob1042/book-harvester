import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json,audio,sentence,mockAi} from './helpers.js';
import {dispatch,processJob} from '../src/queue.ts';
import {harvest} from '../src/ai.ts';
import {getCapture} from '../src/core.ts';
const save=async(f,text=sentence)=>{const r=await f.request('/api/captures',{...json('POST',{text,source:''}),headers:{'Content-Type':'application/json','idempotency-key':crypto.randomUUID()}});assert.equal(r.status,201);return (await r.json()).id;};
test('save, view, cron and correction never authorize extraction; explicit run is local and idempotent',async t=>{
 const f=await fixture();f.env.AI_EXECUTION_POLICY='explicit';t.after(f.close);await f.login();const id=await save(f);await f.drain();await dispatch(f.env);await f.drain();
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,0);assert.equal((await getCapture(f.env,id)).job.error_code,'extraction_required');
 await assert.rejects(harvest(f.env,await getCapture(f.env,id),[],'',mockAi),/extraction_required/);
 let r=await f.request(`/api/captures/${id}/extract`,json('POST',{version:1}));assert.equal(r.status,202);await f.drain();
 assert.equal((await getCapture(f.env,id)).job.state,'completed');assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,1);
 for(const table of ['graph_jobs','theme_jobs','embedding_jobs'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 await f.request(`/api/captures/${id}/extract`,json('POST',{version:1}));await f.drain();assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,1);
 await f.request(`/api/captures/${id}`,json('PATCH',{version:1,corrected_text:'訂正文'}));await f.drain();assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,1);
 assert.equal((await f.request(`/api/captures/${id}/extract`,json('POST',{version:1}))).status,409);
});
test('audio save does not transcribe; URL save does not retrieve and a source link is not input material',async t=>{
 const f=await fixture();f.env.AI_EXECUTION_POLICY='explicit';t.after(f.close);await f.login();await save(f,'https://www.meti.go.jp/example');
 await f.request('/api/captures',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:audio()});await f.drain();assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,0);
 const r=await f.request('/api/captures',{...json('POST',{text:sentence,source:'https://www.meti.go.jp/example'}),headers:{'Content-Type':'application/json','idempotency-key':crypto.randomUUID()}});const id=(await r.json()).id;
 await f.request(`/api/captures/${id}/extract`,json('POST',{version:1}));await f.drain();assert.equal((await getCapture(f.env,id)).job.state,'completed');
});
import {makePdf} from './document-fixtures.js';
test('PDF stays unparsed on save, explicit extraction retains cross-page context',async t=>{
 const f=await fixture();f.env.AI_EXECUTION_POLICY='explicit';t.after(f.close);await f.login();const body=new FormData();body.set('file',new Blob([makePdf()],{type:'application/pdf'}),'document.pdf');
 const r=await f.request('/api/imports',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body});const {id}=await r.json();await f.drain();assert.equal(f.db.prepare('SELECT count(*) n FROM import_items').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,0);
 assert.equal((await f.request(`/api/imports/${id}/extract`,json('POST',{}))).status,202);
 await f.drain(async(url,opts)=>{const response=await mockAi(url,opts);const data=await response.json();const out=JSON.parse(data.output[0].content[0].text);const input=JSON.parse(JSON.parse(opts.body).input[0].content[0].text);out.extracted_text=input.original_or_corrected_text;out.claims=[];out.concepts=[];out.questions=[];out.view_draft=null;data.output[0].content[0].text=JSON.stringify(out);return Response.json(data);});
 const captures=f.db.prepare('SELECT original_text FROM captures').all();assert.equal(captures.length,1);assert.match(captures[0].original_text,/Supply constraint/);assert.match(captures[0].original_text,/Unread second/);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,1);
});

test('missing AI policy also keeps new and legacy queued records dormant',async t=>{const f=await fixture({policy:undefined});t.after(f.close);delete f.env.AI_EXECUTION_POLICY;await f.login();const id=await save(f);await f.drain();f.db.prepare("UPDATE jobs SET state='pending',error_code=NULL WHERE capture_id=?").run(id);await dispatch(f.env);await processJob(f.env,f.db.prepare('SELECT id FROM jobs WHERE capture_id=?').get(id).id,mockAi);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n,0);assert.equal(f.messages.length,0);});
