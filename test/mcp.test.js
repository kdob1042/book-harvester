import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sentence} from './helpers.js';
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

test('explicit AI policy performs ingestion once and schedules no automatic cross-record AI',async()=>{
 const f=await fixture();f.env.AI_EXECUTION_POLICY='explicit';
 const saved=await callBook(f.env,f.ctx,'save_capture',{text:sentence,source:'供給のしくみ',idempotency_key:'explicit-ingest-key-0001'});
 await f.drain();
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(saved.data.id).state,'completed');
 for(const table of ['graph_jobs','theme_jobs','embedding_jobs','reflection_jobs','bibliography_jobs'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0,table);
 assert.equal((await callBook(f.env,f.ctx,'get_status',{})).ai_policy,'ingestion_and_explicit_actions');
});
test('theme conversation draft is separate from records and views, bound to context, and idempotent',async()=>{
 const f=await fixture();f.env.AI_EXECUTION_POLICY='explicit';
 const context=await callBook(f.env,f.ctx,'get_theme_context',{id:'theme:work'});
 const args={id:'theme:work',version:context.theme.version,context_token:context.context_token,body:'未検証の会話の仮説',idempotency_key:'theme-draft-key-00001'};
 const saved=await callBook(f.env,f.ctx,'save_analysis_draft',args);
 assert.equal(saved.origin,'ai_conversation');assert.equal(saved.ai_called,false);
 assert.deepEqual(await callBook(f.env,f.ctx,'save_analysis_draft',args),saved);
 for(const table of ['captures','views','theme_jobs','ai_calls'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
 await assert.rejects(callBook(f.env,f.ctx,'save_analysis_draft',{...args,body:'changed'}),/idempotency_conflict/);
 await assert.rejects(callBook(f.env,f.ctx,'save_analysis_draft',{...args,idempotency_key:'theme-draft-key-00002'}),/theme_context_changed/);
});
test('explicit relation discovery authorizes only current record jobs',async()=>{
 const f=await fixture();f.env.AI_EXECUTION_POLICY='explicit';const saved=await callBook(f.env,f.ctx,'save_capture',{text:sentence,source:'供給のしくみ',idempotency_key:'discovery-capture-key-001'});await f.drain();
 const args={id:saved.data.id,version:1,idempotency_key:'explicit-discovery-key-01'};
 const action=await callBook(f.env,f.ctx,'discover_relations',args);assert.equal(action.accepted,true);await f.drain();
 assert.equal(f.db.prepare('SELECT state FROM graph_jobs WHERE capture_id=?').get(saved.data.id).state,'completed');
 assert.equal(f.db.prepare("SELECT state FROM theme_jobs WHERE kind='membership' AND target_id=?").get(saved.data.id).state,'completed');
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM theme_jobs WHERE kind='synthesis'").get().n,0);
 const before=f.db.prepare('SELECT count(*) AS n FROM ai_calls').get().n;await callBook(f.env,f.ctx,'discover_relations',args);await f.drain();assert.equal(f.db.prepare('SELECT count(*) AS n FROM ai_calls').get().n,before);
});
test('bounded exports omit private object keys and support pagination',async()=>{
 const f=await fixture();await callBook(f.env,f.ctx,'save_capture',{text:'書き出し',idempotency_key:'export-capture-key-0001'});
 const page=await callBook(f.env,f.ctx,'export_records',{entity:'captures',limit:1});assert.equal(page.records.length,1);assert.equal(page.records[0].request_key,undefined);assert.equal(page.records[0].request_hash,undefined);
 await assert.rejects(callBook(f.env,f.ctx,'export_records',{entity:'sessions'}),/invalid_export_entity/);await f.settle();
});
