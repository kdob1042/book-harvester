import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json,mockAi,setProviderDouble} from './helpers.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<300;n++){if(fn())return;await sleep(5);}throw Error('timeout');}
async function deliver(f,body){let ack=false,retry=false;await f.worker.queue({queue:'test',messages:[{body,ack(){ack=true;},retry(){retry=true;}}]},f.env);assert.equal(retry,false);assert.equal(ack,true);}

test('actual capture route keeps originals and canceled queue delivery never calls the provider',async t=>{
 const f=await fixture();t.after(f.close);f.env.AI_EXECUTION_POLICY='explicit';await f.login();const op=crypto.randomUUID();
 const options=json('POST',{text:'原資料を保存する。'});options.headers['Idempotency-Key']=crypto.randomUUID();options.headers['x-ai-operation-id']=op;
 const response=await f.request('/api/captures',options);assert.equal(response.status,201);const saved=await response.json();assert.equal(saved.ai_operation.id,op);await f.settle();
 const canceled=await (await f.request(`/api/ai-operations/${op}/cancel`,json('POST',{}))).json();assert.equal(canceled.state,'canceled');
 let calls=0;setProviderDouble(async()=>{calls++;throw Error('must not call');});t.after(()=>setProviderDouble(null));
 for(const body of f.messages.splice(0))await deliver(f,body);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT original_text FROM captures WHERE id=?').get(saved.id).original_text,'原資料を保存する。');assert.equal(f.db.prepare('SELECT count(*) AS n FROM harvests').get().n,0);
});

test('actual in-flight capture harvest discards late output without losing its original or usage audit',async t=>{
 const f=await fixture();t.after(f.close);f.env.AI_EXECUTION_POLICY='explicit';await f.login();const op=crypto.randomUUID(),options=json('POST',{text:'供給能力が追いつかないと価格が上昇する。'});options.headers['Idempotency-Key']=crypto.randomUUID();options.headers['x-ai-operation-id']=op;
 const saved=await (await f.request('/api/captures',options)).json();await f.settle();let release,entered=false;const gate=new Promise(r=>{release=r;});
 setProviderDouble(async(...args)=>{entered=true;await gate;return mockAi(...args);});t.after(()=>setProviderDouble(null));
 const running=deliver(f,f.messages.shift());await until(()=>entered);assert.equal((await (await f.request(`/api/ai-operations/${op}`)).json()).state,'running');
 await f.request(`/api/ai-operations/${op}/cancel`,json('POST',{}));release();await running;
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM harvests').get().n,0);assert.ok(f.db.prepare('SELECT original_text FROM captures WHERE id=?').get(saved.id));assert.equal(f.db.prepare('SELECT calls FROM ai_daily').get().calls,1);assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(saved.id).state,'canceled');
});
