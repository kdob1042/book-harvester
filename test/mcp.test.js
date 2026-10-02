import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {callBook} from '../src/book-operations.ts';
import {toolSpecs,required} from '../src/mcp-tools.ts';
test('MCP save uses independent source and same Web record; retries do not duplicate',async()=>{
 const {env}=await fixture();const pending=[];const ctx={waitUntil:p=>pending.push(p)};
 const a={text:'MCP独立メモ',idempotency_key:'mcp-test-save-key-0001'};
 const saved=await callBook(env,ctx,'save_capture',a);assert.equal(saved.status,201);
 const repeat=await callBook(env,ctx,'save_capture',a);assert.equal(repeat.data.id,saved.data.id);
 const record=await callBook(env,ctx,'get_record',{id:saved.data.id});assert.equal(record.data.original_text,a.text);assert.equal(record.data.source_id,null);
 const search=await callBook(env,ctx,'search_records',{query:'独立',limit:1});assert.equal(search.records[0].id,saved.data.id);assert.equal(search.ai_called,false);
 await Promise.all(pending);
});
test('MCP theme reads use existing seeded model',async()=>{
 const {env}=await fixture();const ctx={waitUntil:()=>{}};
 const themes=await callBook(env,ctx,'get_domains',{});assert.equal(themes.status,200);
 const theme=await callBook(env,ctx,'get_theme',{id:'theme:work'});assert.equal(theme.status,200);
 const status=await callBook(env,ctx,'get_status',{});assert.equal(status.capabilities.themes,true);
});
test('MCP tools have distinct scopes and required version for destructive actions',()=>{
 assert.equal(new Set(toolSpecs.map(x=>x[0])).size,toolSpecs.length);
 assert.ok(required.delete_capture.includes('version'));assert.ok(required.delete_capture.includes('confirmation'));
 assert.equal(toolSpecs.find(x=>x[0]==='delete_capture')[2],'book:manage');
});
