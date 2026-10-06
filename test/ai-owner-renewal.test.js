import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sentence} from './helpers.js';
import {operationSnapshot,renewTerminalJobOwner} from '../src/ai-operation-jobs.ts';
import {startExtraction} from '../src/extraction.ts';
import {selectImport,startImportExtraction,retryImport} from '../src/imports.ts';
import {retryResearch} from '../src/research.ts';
import {changeBookJob} from '../src/book-jobs.ts';

function capture(f){
 const id=crypto.randomUUID();
 f.db.prepare("INSERT INTO captures(id,kind,original_text,note,version,created_at,updated_at,mutation_id,request_key,request_hash) VALUES(?,'text',?,'',1,0,0,?,?,'fixture')").run(id,sentence,id,id);
 return id;
}
function owner(f,kind,jobId,generation='1',state='canceled'){
 const id=crypto.randomUUID();
 f.db.prepare("INSERT INTO ai_operations(id,path,label,mode,state,created_at,updated_at) VALUES(?,'fixture','再試行','queued',?,0,0)").run(id,state);
 f.db.prepare('INSERT INTO ai_operation_jobs VALUES(?,?,?,?)').run(kind,jobId,generation,id);return id;
}
function seed(f,entry){
 const jobId=crypto.randomUUID();
 if(entry==='capture'){
  const target=capture(f);
  f.db.prepare("INSERT INTO jobs(id,capture_id,version,available_at,created_at,state) VALUES(?,?,1,0,0,'canceled')").run(jobId,target);
  return {kind:'capture',jobId,table:'jobs',run:()=>startExtraction(f.env,f.ctx,target,1)};
 }
 if(entry.startsWith('import')){
  const state=entry==='import-select'?'ready':entry==='import-retry'?'failed':'canceled';
  f.db.prepare("INSERT INTO import_jobs(id,request_key,request_hash,format,name,available_at,created_at,state) VALUES(?,?,?,'epub','fixture.epub',0,1,?)").run(jobId,jobId,jobId,state);
  f.db.prepare("INSERT INTO import_items(id,job_id,ordinal,body,state) VALUES(?,?,1,?,?)").run(crypto.randomUUID(),jobId,sentence,entry==='import-retry'?'failed':'available');
  return {kind:'import',jobId,table:'import_jobs',oldState:entry==='import-select'?'completed':entry==='import-retry'?'failed':'canceled',run:()=>entry==='import-select'?selectImport(f.env,jobId,[1]):entry==='import-retry'?retryImport(f.env,jobId):startImportExtraction(f.env,jobId)};
 }
 if(entry==='research'){
  f.db.prepare("INSERT INTO research_runs(id,request_key,request_hash,kind,question,model,available_at,created_at,state) VALUES(?,?,?,'question','問い','mock',0,1,'canceled')").run(jobId,jobId,jobId);
  f.db.prepare("INSERT INTO research_materials(id,run_id,url,retrieved_at,state) VALUES(?,?,'https://www.boj.or.jp/fixture',0,'failed')").run(crypto.randomUUID(),jobId);
  return {kind:'research',jobId,table:'research_runs',run:()=>retryResearch(f.env,jobId)};
 }
 if(entry==='graph'){
  const target=capture(f);
  f.db.prepare("INSERT INTO graph_jobs(id,capture_id,version,available_at,created_at,state) VALUES(?,?,1,0,0,'canceled')").run(jobId,target);
  return {kind:'graph',jobId,table:'graph_jobs',run:()=>changeBookJob(f.env,f.ctx,{kind:'graph',id:jobId,version:1})};
 }
 f.db.prepare("INSERT INTO theme_jobs(id,kind,target_id,version,available_at,created_at,state) VALUES(?,'synthesis','theme:work',1,0,0,'canceled')").run(jobId);
 return {kind:'theme',jobId,table:'theme_jobs',run:()=>changeBookJob(f.env,f.ctx,{kind:'theme',id:jobId,version:1})};
}

for(const entry of ['capture','import-select','import-extract','import-retry','research','graph','theme']){
 test(`${entry} retry exposes its fresh owner and pending job in the same transaction`,{timeout:10000},async t=>{
  const f=await fixture({policy:'explicit'});t.after(f.close);
  const s=seed(f,entry),old=owner(f,s.kind,s.jobId,'1',s.oldState||'canceled'),batch=f.env.DB.batch;let inspected=0,newOwner;
  f.env.DB.batch=async statements=>{
   const result=await batch(statements);
   if(statements.some(x=>x.sql.includes("SELECT ?,?,'再試行'"))){
    inspected++;
    newOwner=f.db.prepare('SELECT operation_id FROM ai_operation_jobs WHERE kind=? AND job_id=?').get(s.kind,s.jobId).operation_id;
    assert.notEqual(newOwner,old);
    // Poll before returning control to the retry caller. Before the fix this
    // observes the previous terminal job and permanently finalizes newOwner.
    assert.equal(f.db.prepare(`SELECT state FROM ${s.table} WHERE id=?`).get(s.jobId).state,'pending');
    assert.equal((await operationSnapshot(f.env,newOwner)).state,'queued');
   }
   return result;
  };
  await s.run();await f.settle();assert.equal(inspected,1);
  assert.equal((await operationSnapshot(f.env,newOwner)).state,'queued');
  assert.equal(f.db.prepare('SELECT state FROM ai_operations WHERE id=?').get(old).state,s.oldState||'canceled');
  if(entry==='research')assert.equal(f.db.prepare('SELECT state FROM research_materials WHERE run_id=?').get(s.jobId).state,'retry');
  if(entry==='import-retry')assert.equal(f.db.prepare('SELECT state FROM import_items WHERE job_id=?').get(s.jobId).state,'available');
  if(entry==='import-select')assert.equal(f.db.prepare('SELECT selected FROM import_items WHERE job_id=?').get(s.jobId).selected,1);
 });
}

test('failed retry transaction rolls back both fresh owner and job reset',async t=>{
 const f=await fixture({policy:'explicit'});t.after(f.close);
 const s=seed(f,'capture'),old=owner(f,s.kind,s.jobId);
 await assert.rejects(renewTerminalJobOwner(f.env,s.kind,s.jobId,[
  f.env.DB.prepare("UPDATE jobs SET state='pending' WHERE id=?").bind(s.jobId),
  f.env.DB.prepare('INSERT INTO missing_fixture_table VALUES(1)'),
 ]));
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_operations').get().n,1);
 assert.equal(f.db.prepare('SELECT operation_id FROM ai_operation_jobs WHERE job_id=?').get(s.jobId).operation_id,old);
 assert.equal(f.db.prepare('SELECT state FROM jobs WHERE id=?').get(s.jobId).state,'canceled');
});
