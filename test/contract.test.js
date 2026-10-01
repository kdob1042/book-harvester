import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateHarvest} from '../src/harvest-contract.js';
import {result} from './helpers.js';
import {validateAnswer} from '../src/harvest-contract.js';
test('reject invented quotation, unresolvable IDs, duplicate IDs, and AI inference marked as fact',()=>{
 const cases=[v=>{v.claims[0].evidence.quote='資料にない引用';},v=>{v.questions[0].claim_ids=['missing'];},v=>{v.concepts[0].id='c1';},v=>{v.claims[0].evidence.origin='ai';},v=>{v.view_draft.claim_ids=[];}];
 for(const mutate of cases){const value=result();mutate(value);assert.throws(()=>validateHarvest(value));}
 assert.equal(validateHarvest(result()).contract_version,1);
});
test('short answers must quote retrieved material and can explicitly leave questions unanswered',()=>{
 assert.throws(()=>validateAnswer({answer:'根拠あり',evidence:[{quote:'この本にはない文章',locator:null}]},'提供した文章'));
 assert.equal(validateAnswer({answer:'この資料だけではわかりません。',evidence:[]},'提供した文章').evidence.length,0);
});
