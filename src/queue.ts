import {retrieveExternal} from './external.ts';
import {automaticAI,allowedAI} from './ai-policy.ts';
import {membershipJobStatement,dispatchThemes,processThemeJob} from './themes.ts';
import {aiConfigured} from './chatgpt.ts';
import {scheduleEmbedding,dispatchEmbeddings,processEmbedding} from './semantic.ts';
import {dispatchResearch,processResearch} from './research.ts';
import {stmt,rows,getCapture,now,id,type Job,type QueueBody} from './core.ts';
import {transcribe,harvest,AiError} from './ai.ts';
import {graphJobStatement,dispatchGraph,processGraphJob} from './graph.ts';
import {dispatchReflections,processReflection,scheduleReflections} from './reflections.ts';
import {dispatchImports,processImport} from './imports.ts';
import {dispatchBibliography,processBibliography,scheduleBibliography} from './bibliography.ts';

export async function dispatch(env:Env) {
 const time=now();
 await env.DB.batch([
  stmt(env,`UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error_code='worker_interrupted',dispatched_at=NULL,lease_token=NULL WHERE state='running' AND lease_until<?`,time),
  stmt(env,`UPDATE jobs SET state='pending',error_code=NULL,dispatched_at=NULL,available_at=? WHERE state='blocked' AND (?=1 AND (error_code='ai_not_configured' OR (error_code IN ('daily_limit','subscription_sharing_usage_limit_exceeded') AND available_at<=?)))`,time,aiConfigured(env)?1:0,time),
 ]);
 const jobs=await rows<Job>(env,`SELECT * FROM jobs WHERE state='pending' AND (?=1 OR EXISTS(SELECT 1 FROM explicit_ai_actions a WHERE a.kind='extract' AND a.target_id=jobs.capture_id AND a.version=jobs.version)) AND available_at<=? AND (dispatched_at IS NULL OR dispatched_at<?) ORDER BY created_at LIMIT 50`,automaticAI(env)?1:0,time,time-300000);
 for(const job of jobs){
  if(!await allowedAI(env,'extract',job.capture_id,job.version))continue;
  const claim=await stmt(env,`UPDATE jobs SET dispatched_at=? WHERE id=? AND state='pending' AND (dispatched_at IS NULL OR dispatched_at<?) RETURNING id`,time,job.id,time-300000).first();
  if(!claim)continue;
  try{await env.HARVEST_QUEUE.send({job_id:job.id},{contentType:'json'});}
  catch{await stmt(env,"UPDATE jobs SET dispatched_at=NULL WHERE id=? AND state='pending'",job.id).run();}
 }
 await dispatchEmbeddings(env);
 await dispatchGraph(env);
 await dispatchReflections(env);
 await dispatchImports(env);
 await dispatchBibliography(env);
 await dispatchResearch(env);
 await dispatchThemes(env);
}

export async function processJob(env:Env,jobId:string,fetcher?:typeof fetch) {
 const permit=await stmt(env,'SELECT capture_id,version FROM jobs WHERE id=?',jobId).first<{capture_id:string;version:number}>();if(!permit||!await allowedAI(env,'extract',permit.capture_id,permit.version))return;
 const token=id(),time=now();
 const job=await stmt(env,`UPDATE jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=?,model=?,prompt_version='harvest-v1'
 WHERE id=? AND state='pending' AND available_at<=? RETURNING *`,token,time+300000,env.OPENAI_MODEL,jobId,time).first<Job>();
 if(!job)return;
 const capture=await getCapture(env,job.capture_id);
 if(!capture||capture.version!==job.version){await stmt(env,"UPDATE jobs SET state='superseded',lease_token=NULL WHERE id=? AND lease_token=?",job.id,token).run();return;}
 try{
  if(!automaticAI(env)&&!await stmt(env,"SELECT 1 FROM explicit_ai_actions WHERE kind='extract' AND target_id=? AND version=?",capture.id,capture.version).first())throw new AiError('extraction_required');
  let transcript=job.transcript||'';
  if(!transcript&&/^https?:\/\/\S+$/.test(capture.original_text)&&!capture.corrected_text){
   const material=await retrieveExternal(env,capture.original_text,fetcher);
   transcript=`取得範囲: ${material.scope}\n取得日時: ${material.retrieved_at}\n${material.warnings.join(' / ')}\n${material.body}`;
   await stmt(env,"UPDATE jobs SET transcript=? WHERE id=? AND lease_token=?",transcript,job.id,token).run();
  }
  if(!transcript){
   for(const a of capture.assets.filter(a=>a.mime.startsWith('audio/'))){
    const cached=await stmt(env,'SELECT text FROM asset_transcripts WHERE asset_id=?',a.id).first<{text:string}>();
    const speech=cached?.text??await transcribe(env,capture,a,fetcher);
    if(!cached)await stmt(env,`INSERT OR IGNORE INTO asset_transcripts(asset_id,text,created_at) SELECT id,?,? FROM assets WHERE id=?`,speech,now(),a.id).run();
    transcript+=`${speech}\n`;
   }
   if(transcript)await stmt(env,"UPDATE jobs SET transcript=? WHERE id=? AND state='running' AND lease_token=?",transcript,job.id,token).run();
  }
  const materialCapture=/^https?:\/\/\S+$/.test(capture.original_text)&&!capture.corrected_text?{...capture,original_text:transcript,import_origin:'source'}:capture;
  const output=await harvest(env,materialCapture,capture.assets,transcript,fetcher);
  const source=output.result.source,sourceId=id();
  const guard=`EXISTS(SELECT 1 FROM jobs j JOIN captures c ON c.id=j.capture_id WHERE j.id=? AND j.state='running' AND j.lease_token=? AND c.version=j.version)`;
  const statements=[
   stmt(env,`INSERT OR REPLACE INTO harvests(capture_id,version,result,created_at) SELECT ?,?,?,? WHERE ${guard}`,capture.id,job.version,JSON.stringify(output.result),now(),job.id,token),
  ];
  if(source.title&&!capture.source_locked){
   statements.push(stmt(env,`INSERT OR IGNORE INTO sources(id,title,certainty,published_at,subject_period,created_at) SELECT ?,?,?,?,?,? WHERE ${guard}`,sourceId,source.title,source.certainty,source.published_at,source.subject_period,now(),job.id,token));
   statements.push(stmt(env,`UPDATE sources SET published_at=COALESCE(?,published_at),subject_period=COALESCE(?,subject_period) WHERE title=? AND ${guard}`,source.published_at,source.subject_period,source.title,job.id,token));
   statements.push(stmt(env,`UPDATE captures SET source_id=(SELECT id FROM sources WHERE title=?),source_inherited=0 WHERE id=? AND source_locked=0 AND ${guard}`,source.title,capture.id,job.id,token));
   statements.push(stmt(env,`INSERT OR REPLACE INTO settings(key,value) SELECT 'current_source',source_id FROM captures WHERE id=? AND source_locked=0 AND id=(SELECT id FROM captures ORDER BY created_at DESC,rowid DESC LIMIT 1) AND ${guard}`,capture.id,job.id,token));
  }
  statements.push(stmt(env,`UPDATE captures SET page=?,chapter=?,locator_certainty=? WHERE id=? AND source_locked=0 AND ${guard}`,source.page,source.chapter,source.certainty,capture.id,job.id,token));
  if(automaticAI(env))statements.push(graphJobStatement(env,capture.id,job.version,guard,[job.id,token]),membershipJobStatement(env,capture.id,job.version,guard,[job.id,token]));
  statements.push(stmt(env,`UPDATE jobs SET state=CASE WHEN version=(SELECT version FROM captures WHERE id=?) THEN 'completed' ELSE 'superseded' END,
   error_code=NULL,model=?,input_tokens=?,output_tokens=?,finished_at=?,lease_token=NULL WHERE id=? AND state='running' AND lease_token=?`,capture.id,output.model,output.usage.input_tokens||0,output.usage.output_tokens||0,now(),job.id,token));
  await env.DB.batch(statements);
  if(automaticAI(env)){
  await scheduleReflections(env,capture.id);
  await scheduleBibliography(env,capture.id,job.version);
  await scheduleEmbedding(env,capture.id,job.version);
  await dispatchEmbeddings(env);
  await dispatchGraph(env);
  await dispatchThemes(env);
  }
 }catch(e){
  const safe=e instanceof AiError?e:new AiError('processing_failed'),blocked=['extraction_required','ai_not_configured','daily_limit','subscription_reauth_required','subscription_sharing_usage_limit_exceeded','subscription_audio_unsupported'].includes(safe.code);
  const next=blocked?'blocked':safe.retryable&&job.attempts<3?'pending':'failed';
  const tomorrow=new Date();tomorrow.setUTCHours(24,0,0,0);
  await stmt(env,`UPDATE jobs SET state=?,error_code=?,available_at=?,dispatched_at=NULL,lease_token=NULL WHERE id=? AND state='running' AND lease_token=?`,
   next,safe.code,['daily_limit','subscription_sharing_usage_limit_exceeded'].includes(safe.code)?tomorrow.getTime():now()+1000*2**job.attempts,job.id,token).run();
 }
}

export async function cleanup(env:Env){
 const staged=await rows<{object_key:string}>(env,`SELECT s.object_key FROM staged_uploads s LEFT JOIN assets a ON a.object_key=s.object_key WHERE a.id IS NULL AND NOT EXISTS(SELECT 1 FROM import_jobs WHERE object_key=s.object_key) AND NOT EXISTS(SELECT 1 FROM import_items WHERE object_key=s.object_key) AND s.created_at<? LIMIT 50`,now()-86400000);
 const deleted=await rows<{object_key:string}>(env,'SELECT object_key FROM object_deletions LIMIT 50');
 for(const {object_key:key} of [...staged,...deleted]){
  await env.ORIGINALS.delete(key);
  await env.DB.batch([stmt(env,'DELETE FROM staged_uploads WHERE object_key=?',key),stmt(env,'DELETE FROM object_deletions WHERE object_key=?',key)]);
 }
 await env.DB.batch([stmt(env,'DELETE FROM sessions WHERE expires<?',now()),stmt(env,'DELETE FROM login_limits WHERE reset_at<?',now())]);
}

export async function consume(batch:MessageBatch<unknown>,env:Env){
 for(const message of batch.messages){
  try{
   const body=message.body;
   if(body&&typeof body==='object'&&'job_id' in body&&typeof body.job_id==='string')await processJob(env,body.job_id);
   if(body&&typeof body==='object'&&'graph_job_id' in body&&typeof body.graph_job_id==='string')await processGraphJob(env,body.graph_job_id);
   if(body&&typeof body==='object'&&'reflection_job_id' in body&&typeof body.reflection_job_id==='string')await processReflection(env,body.reflection_job_id);
   if(body&&typeof body==='object'&&'import_job_id' in body&&typeof body.import_job_id==='string')await processImport(env,body.import_job_id);
   if(body&&typeof body==='object'&&'bibliography_capture_id' in body&&typeof body.bibliography_capture_id==='string')await processBibliography(env,body.bibliography_capture_id);
   if(body&&typeof body==='object'&&'research_id' in body&&typeof body.research_id==='string')await processResearch(env,body.research_id);
   if(body&&typeof body==='object'&&'embedding_capture_id' in body&&typeof body.embedding_capture_id==='string')await processEmbedding(env,body.embedding_capture_id);
   if(body&&typeof body==='object'&&'theme_job_id' in body&&typeof body.theme_job_id==='string')await processThemeJob(env,body.theme_job_id);
   message.ack();
  }
  catch{message.retry({delaySeconds:60});}
 }
}
