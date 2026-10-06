import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeAIAction} from '../public/ai-action-contract.js';
test('batch proposals and explicit extraction use the cancellable AI boundary',()=>{
 for(const path of ['/api/book/integration-proposals','/api/book/integration-proposals/execute'])assert.equal(describeAIAction(path,'POST')?.mode,'inline');
 for(const path of ['/api/captures/example/extract','/api/imports/example/extract'])assert.equal(describeAIAction(path,'POST')?.mode,'queued');
 assert.equal(describeAIAction('/api/book/integration-proposals','GET'),null);
 assert.equal(describeAIAction('/api/themes/example/drilldown/candidates','POST'),null);
});

test('retained outbox originals without request metadata do not break bootstrap classification',()=>{
 for(const path of [undefined,null,42,{},new Blob(['original'])])assert.equal(describeAIAction(path,undefined),null);
 for(const method of [null,42,{}])assert.equal(describeAIAction('/api/captures',method),null);
 assert.equal(describeAIAction('/api/captures','POST')?.mode,'ingestion');
});
