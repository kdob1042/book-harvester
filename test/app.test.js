import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,photo,audio,json,mockAi,result,sentence} from './helpers.js';
import {dispatch,processJob} from '../src/queue.ts';

const key=n=>`fixture-request-${String(n).padStart(8,'0')}`;
async function save(f,body=photo(),n=1){const response=await f.request('/api/captures',{method:'POST',headers:{'Idempotency-Key':key(n)},body});assert.equal(response.status,201);return (await response.json()).id;}

test('photo -> saved job -> closed browser -> harvest -> adopt -> edit/restore -> original export',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const captureId=await save(f);
 let c=await (await f.request(`/api/captures/${captureId}`)).json();assert.equal(c.harvest,null);assert.equal(c.job.state,'pending');assert.equal(c.assets.length,1);
 await f.request('/api/logout',json('POST',{}));await f.drain(); // Processing does not depend on an active browser session.
 assert.equal((await f.request(`/api/assets/${c.assets[0].id}`)).status,401);
 await f.login();c=await (await f.request(`/api/captures/${captureId}`)).json();assert.equal(c.job.state,'completed');assert.equal(c.harvest.contract_version,1);assert.equal(c.source_title,'供給のしくみ');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM views').get().n,0);
 const adopted=await (await f.request(`/api/captures/${captureId}/adopt`,json('POST',{version:1}))).json();
 const duplicate=await (await f.request(`/api/captures/${captureId}/adopt`,json('POST',{version:1}))).json();assert.equal(adopted.id,duplicate.id);
 assert.equal((await f.request(`/api/views/${adopted.id}`,json('PATCH',{version:1,body:'需要と供給能力を合わせて判断する。',reason:'条件を明確にした。'}))).status,200);
 assert.equal((await f.request(`/api/views/${adopted.id}`,json('PATCH',{version:1,body:'古い編集',reason:'古い'}))).status,409);
 assert.equal((await f.request(`/api/views/${adopted.id}`,json('PATCH',{version:2,restore_version:1}))).status,200);
 const v=await (await f.request(`/api/views/${adopted.id}`)).json();assert.equal(v.version,3);assert.equal(v.revisions.length,3);assert.equal(v.body,result().view_draft.text);assert.equal(v.revisions[0].references.capture_version,1);
 const searched=await (await f.request('/api/state?q=供給制約')).json();assert.equal(searched.captures.length,1);
 const exported=await (await f.request('/api/export')).json();assert.equal(exported.assets.length,1);assert.ok(exported.assets[0].base64);assert.equal(exported.view_revisions.length,3);assert.ok(!JSON.stringify(exported).includes('test-fixture-key'));
});

test('audio uses separate transcription and Responses contracts; original speech remains private',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const captureId=await save(f,audio());const seen=[];
 await f.drain(async (url,opts)=>{seen.push(url);if(url.endsWith('transcriptions')){assert.ok(opts.body instanceof FormData);assert.equal(opts.body.get('model'),'gpt-4o-mini-transcribe');}
 else{const input=JSON.parse(opts.body);assert.equal(input.store,false);assert.equal(input.text.format.type,'json_schema');assert.equal(input.text.format.strict,true);if(input.text.format.name==='capture_harvest_v1')assert.ok(input.input[0].content[0].text.includes(sentence));else assert.ok(input.input.includes(sentence));}return mockAi(url,opts);});
 assert.equal(seen.length,4);assert.ok(seen[0].endsWith('/audio/transcriptions'));assert.ok(seen[1].endsWith('/responses'));
 const c=await (await f.request(`/api/captures/${captureId}`)).json();assert.equal(c.job.state,'completed');assert.equal(c.assets[0].mime,'audio/wav');assert.equal(c.job.transcript.trim(),sentence);
});

test('idempotency survives concurrent double-send; keys cannot replace different content',async t=>{
 const f=await fixture();t.after(f.close);await f.login();
 const requests=await Promise.all([1,2].map(()=>f.request('/api/captures',{method:'POST',headers:{'Idempotency-Key':key(1)},body:photo()})));
 assert.deepEqual(requests.map(r=>r.status).sort(),[200,201]);const saved=await Promise.all(requests.map(r=>r.json()));assert.equal(saved[0].id,saved[1].id);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n,1);assert.equal(f.objects.size,1);
 assert.equal((await f.request('/api/captures',{...json('POST',{text:'different'}),headers:{'Content-Type':'application/json','Idempotency-Key':key(1)}})).status,409);
});

test('missing key and API failure preserve originals; queue-send failure is recovered from durable outbox',async t=>{
 const f=await fixture({key:''});t.after(f.close);await f.login();
 f.env.HARVEST_QUEUE.send=async()=>{throw new Error('queue down');};const captureId=await save(f);await f.settle();
 assert.equal(f.db.prepare('SELECT dispatched_at FROM jobs').get().dispatched_at,null);
 f.env.HARVEST_QUEUE.send=async message=>f.messages.push(message);await dispatch(f.env);await f.drain();
 let c=await (await f.request(`/api/captures/${captureId}`)).json();assert.equal(c.job.state,'blocked');assert.equal(c.job.error_code,'ai_not_configured');assert.equal(f.objects.size,1);
 f.env.OPENAI_API_KEY='fixture-key';await dispatch(f.env);
 await f.drain(async()=>new Response('rejected',{status:401}));c=await (await f.request(`/api/captures/${captureId}`)).json();assert.equal(c.job.state,'failed');assert.equal(c.harvest,null);assert.equal(f.objects.size,1);
 assert.equal((await f.request(`/api/captures/${captureId}/retry`,json('POST',{version:1}))).status,200);await f.drain();
 c=await (await f.request(`/api/captures/${captureId}`)).json();assert.equal(c.job.state,'completed');
});

test('old capture version and in-flight stale AI result cannot overwrite a correction',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const captureId=await save(f);await f.settle();const job=f.messages.shift();
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const processing=processJob(f.env,job.job_id,async(...args)=>{await gate;return mockAi(...args);});
 while(f.db.prepare('SELECT state FROM jobs').get().state!=='running')await new Promise(resolve=>setTimeout(resolve,1));
 assert.equal((await f.request(`/api/captures/${captureId}`,json('PATCH',{version:1,corrected_text:'訂正した本文',source_title:'正しい本',page:'12'}))).status,200);
 assert.equal((await f.request(`/api/captures/${captureId}`,json('PATCH',{version:1,note:'古い書き込み'}))).status,409);
 release();await processing;
 const c=await (await f.request(`/api/captures/${captureId}`)).json();assert.equal(c.version,2);assert.equal(c.harvest,null);assert.equal(c.source_title,'正しい本');assert.equal(c.page,'12');
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE version=1').get().state,'superseded');assert.equal(f.db.prepare('SELECT count(*) AS n FROM capture_revisions').get().n,2);
});

test('attachment supplementation is explicit, idempotent, and revision guarded',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const captureId=await save(f);await f.drain();
 const options=()=>({method:'POST',headers:{'Idempotency-Key':key(2),'X-Capture-Version':'1'},body:audio()});
 assert.equal((await f.request(`/api/captures/${captureId}/assets`,options())).status,201);
 assert.equal((await f.request(`/api/captures/${captureId}/assets`,options())).status,200);
 const c=await (await f.request(`/api/captures/${captureId}`)).json();assert.equal(c.version,2);assert.equal(c.assets.length,2);
 assert.equal((await f.request(`/api/captures/${captureId}/assets`,{method:'POST',headers:{'Idempotency-Key':key(3),'X-Capture-Version':'1'},body:photo()})).status,409);
});

test('daily API cap is atomic across jobs and original storage is independent',async t=>{
 const f=await fixture({limit:'1'});t.after(f.close);await f.login();await save(f,photo(),1);await save(f,photo(),2);await f.drain();
 assert.equal(f.db.prepare('SELECT calls FROM ai_daily').get().calls,1);assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='blocked'").get().n,1);assert.equal(f.objects.size,2);
});

test('unauthenticated API/assets/export and cross-origin mutations are rejected; spoofed image bytes fail',async t=>{
 const f=await fixture();t.after(f.close);
 for(const path of ['/api/state','/api/export','/api/assets/00000000-0000-0000-0000-000000000000'])assert.equal((await f.request(path)).status,401);
 await f.login();assert.equal((await f.request('/api/captures',{...json('POST',{text:'text'}),origin:'https://evil.example'})).status,403);
 const form=new FormData();form.set('file',new Blob(['<svg><script>bad</script></svg>'],{type:'image/png'}),'bad.png');
 assert.equal((await f.request('/api/captures',{method:'POST',headers:{'Idempotency-Key':key(1)},body:form})).status,415);assert.equal(f.db.prepare('SELECT count(*) AS n FROM captures').get().n,0);
});

test('source deletion removes originals and AI derivatives while adopted text/history remain',async t=>{
 const f=await fixture();t.after(f.close);await f.login();const captureId=await save(f);await f.drain();await f.request(`/api/captures/${captureId}/adopt`,json('POST',{version:1}));
 assert.equal((await f.request(`/api/captures/${captureId}`,json('DELETE',{version:1}))).status,200);
 for(const table of ['captures','assets','jobs','harvests','capture_revisions','sources','graph_jobs','graph_generations','graph_nodes','concepts'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0,table);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM views').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM view_revisions').get().n,1);assert.equal(f.objects.size,0);assert.equal(f.db.prepare('SELECT calls FROM ai_daily').get().calls,4); // Harvest, graph, semantic index, and theme membership.
});
