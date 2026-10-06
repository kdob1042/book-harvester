import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIntegrationAttempt,integrationActionKey,settleIntegrationAttempt,importExtractionLabel} from '../public/ai-retry.js';
import {describeAIAction} from '../public/ai-action-contract.js';
import {createAiOperations} from '../public/ai-operations.js';

function storage(){const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
const actionKey=integrationActionKey('discovery-fixture','parent',['b','a']);

test('confirmed canceled or failed direct integration gets a fresh retry identity',()=>{
 for(const outcome of [{canceled:true},{state:'failed'},{ai_operation:{state:'canceled'}},{ai_operation:{state:'failed'}}]){
  const saved=storage(),attempt=createIntegrationAttempt(saved,actionKey);
  assert.equal(attempt.settle(outcome),true);
  assert.notEqual(createIntegrationAttempt(saved,actionKey).key,attempt.key);
 }
});

test('ambiguous transport, unconfirmed stop and successful integration preserve deduplication keys',()=>{
 for(const outcome of [Error('offline'),Object.assign(Error('gateway timeout'),{status:504}),{stopPending:true},{state:'running'},{ai_operation:{state:'unknown'}},{state:'completed'},{ai_operation:{state:'completed'}},{state:'completed',canceled:true}]){
  const saved=storage(),attempt=createIntegrationAttempt(saved,actionKey);
  assert.equal(attempt.settle(outcome),false);
  assert.equal(createIntegrationAttempt(saved,actionKey).key,attempt.key);
 }
 assert.equal(integrationActionKey('discovery-fixture','parent',['a','b']),actionKey);
});

test('late failure from an older attempt cannot remove a newer retry key',()=>{
 const saved=storage(),old=createIntegrationAttempt(saved,actionKey);
 old.settle({state:'failed'});
 const next=createIntegrationAttempt(saved,actionKey);
 assert.equal(settleIntegrationAttempt(saved,old.retry,{state:'canceled'}),false);
 assert.equal(saved.getItem(actionKey),next.key);
});

test('operation cancellation after an ambiguous HTTP failure releases its integration retry key',async()=>{
 const saved=storage(),prior=globalThis.sessionStorage;globalThis.sessionStorage=saved;
 try{
  const attempt=createIntegrationAttempt(saved,actionKey),tasks=new Map();let serial=0;
  const activity={start(value){tasks.set(++serial,value);return serial;},update(id,value){Object.assign(tasks.get(id),value);},remove(id){tasks.delete(id);},clear(){tasks.clear();}};
  const controller=createAiOperations({activity,request:async path=>{if(path.endsWith('/cancel'))return {state:'canceled'};throw Error('response lost');}});
  controller.activate('owner');
  await assert.rejects(controller.execute('/api/book/integrate',{method:'POST'},{label:'統合',mode:'inline',integrationRetry:attempt.retry}),/response lost/);
  assert.equal(saved.getItem(actionKey),attempt.key);
  await [...tasks.values()][0].cancel();
  assert.equal(saved.getItem(actionKey),null);
 }finally{if(prior===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=prior;}
});

test('reload recovers retry metadata and only reads terminal status before releasing the key',async()=>{
 const saved=storage(),prior=globalThis.sessionStorage;globalThis.sessionStorage=saved;
 try{
  const attempt=createIntegrationAttempt(saved,actionKey),id=crypto.randomUUID(),calls=[];
  saved.setItem('book-ai-operations:owner',JSON.stringify([{id,label:'統合',mode:'inline',path:'/api/book/integrate',integrationRetry:attempt.retry}]));
  const activity={start(){return 1;},update(){},remove(){},clear(){}};
  const controller=createAiOperations({activity,request:async(path,options)=>{calls.push({path,options});return path==='/api/ai-operations'?{operations:[]}:{id,state:'failed'};}});
  controller.activate('owner');assert.equal(saved.getItem(actionKey),attempt.key);
  await controller.refresh();assert.equal(saved.getItem(actionKey),null);
  assert.ok(calls.every(call=>!call.options.method||call.options.method==='GET'));
 }finally{if(prior===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=prior;}
});

test('canceled import exposes explicit extraction retry, leaving active and completed imports alone',()=>{
 assert.equal(importExtractionLabel({state:'canceled',error_code:null}),'抽出を再試行 · AI');
 assert.equal(importExtractionLabel({state:'ready',error_code:'extraction_required'}),'抽出する · AI');
 for(const state of ['pending','running','completed'])assert.equal(importExtractionLabel({state,error_code:null}),null);
 assert.equal(describeAIAction('/api/imports/import-fixture/extract','POST').mode,'queued');
});
