import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {scopeAIOperation,cancellableAI,AIOperationCanceled} from '../src/ai-cancellation.ts';
test('canceling an AI request preserves a refreshed login credential',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());for(const table of ['jobs','graph_jobs','theme_jobs','research_runs','import_jobs','embedding_jobs','bibliography_jobs','reflection_jobs'])db.exec(`CREATE TABLE ${table}(id TEXT,capture_id TEXT,version INTEGER,state TEXT,created_at INTEGER,signature TEXT)`);db.exec(`CREATE TABLE discovery_runs(id TEXT,state TEXT,error TEXT);CREATE TABLE integration_runs(id TEXT,state TEXT,error TEXT);CREATE TABLE integration_proposal_runs(id TEXT,state TEXT,error TEXT);CREATE TABLE integration_proposals(id TEXT,state TEXT,attempt INTEGER);CREATE TABLE book_operation_receipts(operation_key TEXT,state TEXT);`);db.exec(readFileSync(new URL('../migrations/0020_ai_operations.sql',import.meta.url),'utf8'));db.exec('CREATE TABLE chatgpt_sessions(id TEXT,token TEXT)');
 class Statement{
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){return new Statement(this.sql,values);}
  exec(){return {results:db.prepare(this.sql).all(...this.values),success:true,meta:{}};}
  async first(column){const row=this.exec().results[0];return column?row?.[column]:row;}
  async run(){return this.exec();}
 }
 const binding={prepare:sql=>new Statement(sql),async batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>s.exec());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const id=crypto.randomUUID();db.prepare("INSERT INTO ai_operations(id,path,label,mode,state,created_at,updated_at) VALUES(?,'/ai','AI','inline','running',0,0)").run(id);const env=scopeAIOperation({DB:binding},id);
 let release,started=false,calls=0;const gate=new Promise(r=>{release=r;});
 const work=cancellableAI(env,async(url,init)=>{if(url.endsWith('/oauth/token')){started=true;await gate;assert.notEqual(init?.signal?.aborted,true);return Response.json({token:'rotated'});}calls++;return Response.json({});},async fetcher=>{
  const value=await (await fetcher('https://auth.example/oauth/token')).json();
  await env.DB.prepare('INSERT INTO chatgpt_sessions VALUES(?,?)').bind('owner',value.token).run();
  return fetcher('https://provider.invalid/responses');
 });
 for(let n=0;!started&&n<100;n++)await new Promise(r=>setTimeout(r,5));assert.ok(started);
 db.prepare("UPDATE ai_operations SET state='canceled' WHERE id=?").run(id);release();await assert.rejects(work,AIOperationCanceled);
 assert.equal(calls,0);assert.equal(db.prepare('SELECT token FROM chatgpt_sessions').get().token,'rotated');
});
