import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,photo,json,mockAi,reflectionResult,graphResponse} from './helpers.js';
import {dispatchReflections,processReflection,periodBounds,splitSession,scheduleReflections} from '../src/reflections.ts';
import {validateReflection} from '../src/reflection-contract.js';
async function save(f,n=1){const r=await f.request('/api/captures',{method:'POST',headers:{'Idempotency-Key':`reflection-fixture-unique-${n}`},body:photo()});assert.equal(r.status,201);return (await r.json()).id;}
async function ready(f,scope='session'){await f.settle();f.db.prepare('UPDATE reflection_jobs SET available_at=0 WHERE scope=?').run(scope);await dispatchReflections(f.env);await f.drain();}

test('recording automatically groups sessions and queues debounced, Japanese-day and weekly reflections without approval',async t=>{
 const f=await fixture();t.after(f.close);await f.login();await save(f,1);await f.drain();const second=await save(f,2);await f.drain();
 assert.equal(f.db.prepare('SELECT count(*) n FROM reading_sessions').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM reading_session_members').get().n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM reflection_jobs').get().n,3);
 assert.equal(f.db.prepare('SELECT count(*) n FROM reflections').get().n,0);await ready(f);
 const state=await (await f.request('/api/state')).json();assert.equal(state.reflections.length,1);assert.equal(state.reflections[0].scope,'session');
 const r=await (await f.request(`/api/reflections/${state.reflections[0].id}`)).json();assert.equal(r.input.captures.length,2);assert.ok(r.result.question_ids[0]);assert.equal(f.db.prepare('SELECT count(*) n FROM views').get().n,0);
 const session=f.db.prepare('SELECT session_id FROM reading_session_members WHERE capture_id=?').get(second).session_id;assert.equal(await splitSession(f.env,session,second),true);await ready(f);
 assert.equal(f.db.prepare('SELECT count(*) n FROM reading_sessions').get().n,2);assert.equal(f.db.prepare('SELECT manual FROM reading_session_members WHERE capture_id=?').get(second).manual,1);
 await scheduleReflections(f.env,second);assert.equal(f.db.prepare('SELECT count(*) n FROM reading_sessions').get().n,2);
});

test('reflection uses adopted revisions only and rejects invented personal quotes, views and references',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const cap=await save(f);await f.drain();await f.request(`/api/captures/${cap}/adopt`,json('POST',{version:1}));await f.settle();
 const input=JSON.parse(f.db.prepare("SELECT input_json FROM reflection_jobs WHERE scope='session'").get().input_json),valid=reflectionResult(input);assert.equal(valid.view_changes.length,1);assert.doesNotThrow(()=>validateReflection(valid,input));
 for(const mutate of [x=>x.user_note={capture_id:cap,quote:'本人の賛同を捏造'},x=>x.question_ids=['missing'],x=>x.view_changes[0].version=99]){const bad=structuredClone(valid);mutate(bad);assert.throws(()=>validateReflection(bad,input));}
 await ready(f);const r=await (await f.request('/api/state')).json();assert.equal(r.reflections[0].result.view_changes.length,1);
 await f.request(`/api/captures/${cap}`,json('DELETE',{version:1}));assert.equal((await (await f.request('/api/state')).json()).reflections.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM reflection_jobs').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM reflections').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM views').get().n,1);
});

test('an in-flight reflection cannot publish a corrected source or overwrite a newer reflection job',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const cap=await save(f);await f.drain();await f.settle();f.db.prepare("UPDATE reflection_jobs SET available_at=0 WHERE scope='session'").run();const job=f.db.prepare("SELECT * FROM reflection_jobs WHERE scope='session'").get();
 let release,entered;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const processing=processReflection(f.env,job.id,async(url,opts)=>{entered();await gate;return mockAi(url,opts);});await start;
 await f.request(`/api/captures/${cap}`,json('PATCH',{version:1,corrected_text:'訂正済みの文章。'}));release();await processing;assert.equal(f.db.prepare('SELECT count(*) n FROM reflections').get().n,0);
});

test('Japanese calendar periods and repeated queue messages do not duplicate reflection output',async t=>{
 assert.equal(periodBounds(Date.UTC(2026,9,1,16),'day').key,'2026-10-02');assert.equal(periodBounds(Date.UTC(2026,9,1,16),'week').key,'2026-09-28');
 const f=await fixture();t.after(f.close);await f.login();await save(f);await f.drain();await ready(f);const job=f.db.prepare("SELECT id FROM reflection_jobs WHERE scope='session'").get();await processReflection(f.env,job.id,mockAi);assert.equal(f.db.prepare('SELECT count(*) n FROM reflections').get().n,1);
 const exported=await (await f.request('/api/export')).json();assert.equal(exported.reading_session_members.length,1);assert.equal(exported.reflections.length,1);assert.equal(typeof exported.reflections[0].result,'object');
});

test('revisit selects semantically reused past questions, holds one daily suggestion and persists opt-out',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const old=await save(f,1);await f.drain();f.db.prepare('UPDATE captures SET created_at=? WHERE id=?').run(Date.now()-10*86400000,old);await save(f,2);await f.drain();
 let state=await (await f.request('/api/state')).json();assert.equal(state.revisits[0].id,old);state=await (await f.request('/api/state')).json();assert.equal(state.revisits[0].id,old);assert.equal(f.db.prepare('SELECT shown_count FROM revisit_state WHERE capture_id=?').get(old).shown_count,1);
 await f.request('/api/revisit/hide',json('POST',{capture_id:old}));assert.equal((await (await f.request('/api/state')).json()).revisits.length,0);
});
