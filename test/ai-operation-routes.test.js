import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeAIAction} from '../public/ai-action-contract.js';
test('batch proposal discovery and execution share the immediate, cancellable AI boundary',()=>{
 for(const path of ['/api/book/integration-proposals','/api/book/integration-proposals/execute'])assert.equal(describeAIAction(path,'POST')?.mode,'inline');
 assert.equal(describeAIAction('/api/book/integration-proposals','GET'),null);
 assert.equal(describeAIAction('/api/themes/example/drilldown/candidates','POST'),null);
});
