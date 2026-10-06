import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAiOperations} from '../public/ai-operations.js';
import {describeAIAction} from '../public/ai-action-contract.js';

const pending=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(request){
 const tasks=new Map();let next=0;
 const activity={start(value){const id=++next;tasks.set(id,value);return id;},update(id,value){if(tasks.has(id))Object.assign(tasks.get(id),value);},remove(id){tasks.delete(id);},clear(){tasks.clear();}};
 return {tasks,controller:createAiOperations({activity,request}),last:()=>[...tasks.values()].at(-1)};
}
const descriptor={label:'深掘り',mode:'inline'};
const options={method:'POST',body:'{}'};

test('stop reports completed when completion wins, never a false canceled state',async()=>{
 const work=pending(),cancel=pending();
 const f=fixture(path=>path.endsWith('/cancel')?cancel.promise:work.promise);
 const result=f.controller.execute('/api/themes/a/drilldown',options,descriptor);
 assert.equal(f.last().state,'running');
 const stop=f.last().cancel();assert.equal(f.last().state,'stopping');
 cancel.resolve({state:'completed'});await stop;
 assert.equal(f.last().state,'completed');
 work.resolve({ai_operation:{state:'completed'},run:'saved'});assert.equal((await result).run,'saved');
 assert.equal(f.last().state,'completed');
});

test('unconfirmed cancellation stays stoppable and retry confirms canceled; late result is not applied',async()=>{
 const work=pending();let attempts=0;
 const f=fixture(async path=>{
  if(!path.endsWith('/cancel'))return work.promise;
  if(++attempts===1)throw Error('network down');
  return {state:'canceled'};
 });
 const result=f.controller.execute('/api/themes/a/drilldown',options,descriptor);
 const rejected=assert.rejects(result,error=>error.canceled===true);
 await assert.rejects(f.last().cancel(),/network down/);
 assert.equal(f.last().state,'unknown');assert.equal(f.last().cancelError,true);
 await f.last().cancel();assert.equal(f.last().state,'canceled');
 work.resolve({ai_operation:{state:'completed'},run:'late'});await rejected;
 assert.equal(f.last().state,'canceled');
});

test('queued acceptance is pending, canonical duplicate owner is used for stop',async()=>{
 const canonical=crypto.randomUUID(),calls=[];
 const f=fixture(async(path,opts)=>{calls.push({path,opts});return path.endsWith('/cancel')?{id:canonical,state:'canceled'}:{ai_operation:{id:canonical,state:'queued'}};});
 await f.controller.execute('/api/captures/a/extract',options,{label:'知見抽出',mode:'queued'});
 assert.equal(f.last().state,'pending');assert.equal(f.tasks.size,1);
 assert.ok(calls[0].opts.headers.get('x-ai-operation-id'));
 await f.last().cancel();assert.equal(calls[1].path,`/api/ai-operations/${canonical}/cancel`);
});

test('a stop racing canonical adoption is forwarded to the original owner',async()=>{
 const work=pending(),canonical=crypto.randomUUID(),stops=[];
 const f=fixture(async(path,opts)=>{if(path.endsWith('/cancel')){stops.push(path);return {state:'canceled'};}return work.promise;});
 const result=f.controller.execute('/api/captures/a/extract',options,{label:'知見抽出',mode:'queued'});
 const rejected=assert.rejects(result,error=>error.canceled===true);
 await f.last().cancel();
 work.resolve({ai_operation:{id:canonical,state:'queued'}});await rejected;
 assert.equal(stops.length,2);assert.equal(stops[1],`/api/ai-operations/${canonical}/cancel`);
 assert.equal(f.last().state,'canceled');
});

test('text extraction and discovery share an operation and canceled continuation never requests AI',async()=>{
 const calls=[];
 const f=fixture(async(path,opts)=>{calls.push({path,opts});return {ai_operation:{state:'queued'}};});
 const operation=f.controller.start({label:'知見抽出・関連探索',mode:'queued'},{path:'/api/captures/a/extract',workflow:'text-discovery'});
 await f.controller.execute('/api/captures/a/extract',options,{mode:'queued'},operation);
 await f.controller.execute('/api/book/discover',options,{mode:'inline'},operation);
 assert.equal(calls[0].opts.headers.get('x-ai-operation-id'),calls[1].opts.headers.get('x-ai-operation-id'));
 assert.equal(calls[0].opts.headers.get('x-ai-operation-workflow'),'text-discovery');
 operation.stopRequested=true;
 await assert.rejects(f.controller.execute('/api/book/discover',options,{mode:'inline'},operation),error=>error.stopPending===true);
 assert.equal(calls.length,2);
});

test('reload recovery only reads server state, including blocked operations that remain cancelable',async()=>{
 const storage=new Map();globalThis.sessionStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
 try{
  const first=fixture(async()=>({ai_operation:{state:'queued'}}));first.controller.activate('owner');
  await first.controller.execute('/api/captures/a/extract',options,{label:'知見抽出',mode:'queued'});
  const calls=[];
  const second=fixture(async(path,opts)=>{calls.push({path,opts});return path==='/api/ai-operations'?{operations:[]}:{state:'blocked'};});
  second.controller.activate('owner');assert.equal(second.last().state,'unknown');
  await second.controller.refresh();assert.equal(second.last().state,'blocked');assert.equal(typeof second.last().cancel,'function');
  assert.ok(calls.length);assert.ok(calls.every(c=>!c.opts.method||c.opts.method==='GET'));
 }finally{delete globalThis.sessionStorage;}
});

test('current UI actions are classified but saving drilldown choices is never AI',()=>{
 for(const path of ['/api/themes/a/drilldown','/api/themes/a/relationships','/api/book/discover','/api/book/integrate','/api/book/integration-proposals','/api/book/integration-proposals/execute','/api/captures/a/ask','/api/captures/a/extract','/api/captures/a/retry','/api/imports/a/extract','/api/graph/rebuild','/api/theme-changes','/api/concept-edits','/api/themes/a/rebuild','/api/research','/api/research/a/retry'])assert.ok(describeAIAction(path,'POST'),path);
 for(const path of ['/api/themes/a/drilldown/save','/api/themes/a/drilldown/candidates','/api/themes/a/relationships/save','/api/themes/a/proposals'])assert.equal(describeAIAction(path,'POST'),null,path);
 assert.equal(describeAIAction('/api/imports/a/select','POST').mode,'ingestion');
 assert.equal(describeAIAction('/api/book/discover','GET'),null);
});


test('canonical adoption cannot revive an owner that this tab already confirmed canceled',async()=>{
 const canonical=crypto.randomUUID();
 const f=fixture(async path=>path.endsWith('/cancel')?{id:canonical,state:'canceled'}:{ai_operation:{id:canonical,state:'queued'}});
 const owner=f.controller.start({label:'知見抽出',mode:'queued'},{id:canonical,path:'/api/captures/a/extract'});
 await f.controller.cancel(owner);
 await assert.rejects(f.controller.execute('/api/captures/a/extract',options,{label:'知見抽出',mode:'queued'}),error=>error.canceled===true);
 assert.equal(f.tasks.size,1);assert.equal(f.last().state,'canceled');
});
