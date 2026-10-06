import {cancellationCleanup} from './ai-cancellation.ts';
import {automaticAI} from './ai-policy.ts';
import {aiConfigured} from './chatgpt.ts';
import {stmt,rows,getCapture,now,id,digest,type Harvest} from './core.ts';
import {call,AiError} from './ai.ts';
import {reflectionSchema,reflectionInstructions,validateReflection} from './reflection-contract.js';
type Scope='session'|'day'|'week';
type Input={scope:Scope;scope_key:string;partial:boolean;captures:{id:string;version:number;note:string;source_title:string|null;page:string|null;harvest:Harvest}[];questions:{id:string;text:string;capture_id:string}[];relations:{id:string;payload:string}[];view_changes:{id:string;version:number;body:string;reason:string;previous_body:string|null}[]};
type Output={summary:string;takeaways:{text:string;capture_ids:string[]}[];question_ids:string[];connections:{relation_id:string;text:string}[];view_changes:{view_id:string;version:number;text:string}[];user_note:{capture_id:string;quote:string}|null};
type Job={id:string;scope:Scope;scope_key:string;signature:string;input_json:string;attempts:number;state:string};
async function referencesCurrent(env:Env,input:Input){
 for(const r of input.relations)if(!await stmt(env,'SELECT id FROM current_graph_relations WHERE id=?',r.id).first())return false;
 return true;
}
const day=86400000,offset=9*3600000;
export function periodBounds(time:number,scope:'day'|'week'){
 const local=new Date(time+offset),midnight=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-offset;
 const start=scope==='day'?midnight:midnight-((local.getUTCDay()+6)%7)*day;
 return {start,end:start+(scope==='day'?day:7*day),key:new Date(start+offset).toISOString().slice(0,10)};
}
async function collect(env:Env,scope:Scope,key:string,start:number,end:number):Promise<Input>{
 const filter=scope==='session'?'c.id IN(SELECT capture_id FROM reading_session_members WHERE session_id=?)':'c.created_at>=? AND c.created_at<?';
 const params=scope==='session'?[key]:[start,end];
 const raw=await rows<{id:string;version:number;note:string;source_title:string|null;page:string|null;result:string}>(env,`SELECT c.id,c.version,c.note,c.page,s.title AS source_title,h.result FROM captures c JOIN harvests h ON h.capture_id=c.id AND h.version=c.version LEFT JOIN sources s ON s.id=c.source_id WHERE ${filter} ORDER BY c.created_at DESC LIMIT 21`,...params);
 const captures=raw.slice(0,20).map(({result,...c})=>({...c,harvest:JSON.parse(result) as Harvest}));
 const capIds=captures.map(c=>c.id);
 const relations=capIds.length?await rows<{id:string;payload:string}>(env,`SELECT id,payload FROM current_graph_relations WHERE capture_id IN(${capIds.map(()=>'?').join(',')}) ORDER BY id LIMIT 20`,...capIds):[];
 const changes=await rows<{id:string;version:number;body:string;reason:string;previous_body:string|null}>(env,`SELECT r.view_id AS id,r.version,r.body,r.reason,p.body AS previous_body FROM view_revisions r LEFT JOIN view_revisions p ON p.view_id=r.view_id AND p.version=r.version-1 JOIN views v ON v.id=r.view_id WHERE ${scope==='session'?'v.capture_id IN(SELECT capture_id FROM reading_session_members WHERE session_id=?)':'r.created_at>=? AND r.created_at<?'} ORDER BY r.created_at DESC LIMIT 10`,...params);
 const questions=captures.flatMap(c=>c.harvest.questions.map(q=>({id:`${c.id}:${c.version}:${q.id}`,text:q.text,capture_id:c.id})));
 return {scope,scope_key:key,partial:raw.length>20,captures,questions,relations,view_changes:changes};
}
async function scheduleScope(env:Env,scope:Scope,key:string,start:number,end:number,available:number){
 const input=await collect(env,scope,key,start,end);if(!input.captures.length&&!input.view_changes.length)return;
 const body=JSON.stringify(input);if(body.length>180000)return;
 const signature=await digest(body);
 await stmt(env,`INSERT INTO reflection_jobs(id,scope,scope_key,start_at,end_at,signature,input_json,available_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)
 ON CONFLICT(scope,scope_key) DO UPDATE SET signature=excluded.signature,input_json=excluded.input_json,start_at=excluded.start_at,end_at=excluded.end_at,state='pending',attempts=0,available_at=excluded.available_at,dispatched_at=NULL,lease_token=NULL,error_code=NULL WHERE signature<>excluded.signature`,id(),scope,key,start,end,signature,body,available,now()).run();
}
export async function scheduleReflections(env:Env,captureId:string,eventTime=now()){if(!automaticAI(env))return;
 const c=await getCapture(env,captureId);if(!c?.harvest)return;
 const existing=await stmt(env,'SELECT session_id,manual FROM reading_session_members WHERE capture_id=?',c.id).first<{session_id:string;manual:number}>();
 let session=existing?.session_id;
 if(!existing?.manual){
  const near=await stmt(env,`SELECT s.id FROM reading_sessions s WHERE s.source_id IS ? AND s.ended_at>=? AND s.started_at<=? AND s.id<>? ORDER BY s.ended_at DESC LIMIT 1`,c.source_id,c.created_at-45*60000,c.created_at+45*60000,c.id).first<{id:string}>();
  session=near?.id||`${c.id}:${c.source_id||'unknown'}`;
  await env.DB.batch([
   stmt(env,'INSERT OR IGNORE INTO reading_sessions(id,source_id,started_at,ended_at) VALUES(?,?,?,?)',session,c.source_id,c.created_at,c.created_at),
   stmt(env,`INSERT INTO reading_session_members(capture_id,session_id) VALUES(?,?) ON CONFLICT(capture_id) DO UPDATE SET session_id=excluded.session_id WHERE manual=0`,c.id,session),
   stmt(env,`UPDATE reading_sessions SET started_at=(SELECT min(c.created_at) FROM captures c JOIN reading_session_members m ON m.capture_id=c.id WHERE m.session_id=?),ended_at=(SELECT max(c.created_at) FROM captures c JOIN reading_session_members m ON m.capture_id=c.id WHERE m.session_id=?) WHERE id=?`,session,session,session),
  ]);
 }
 const s=await stmt(env,'SELECT started_at,ended_at FROM reading_sessions WHERE id=?',session!).first<{started_at:number;ended_at:number}>();
 if(s)await scheduleScope(env,'session',session!,s.started_at,s.ended_at,now()+300000);
 for(const time of new Set([c.created_at,eventTime]))for(const scope of ['day','week'] as const){const p=periodBounds(time,scope);await scheduleScope(env,scope,p.key,p.start,p.end,Math.max(now()+300000,p.end+60000));}
}
export async function dispatchReflections(env:Env){
 env=cancellationCleanup(env);if(!automaticAI(env))return;
 const time=now();
 await env.DB.batch([
  stmt(env,`UPDATE reflection_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,dispatched_at=NULL,lease_token=NULL,error_code='worker_interrupted' WHERE state='running' AND lease_until<?`,time),
  stmt(env,`UPDATE reflection_jobs SET state='pending',dispatched_at=NULL,error_code=NULL,available_at=? WHERE state='blocked' AND ?=1 AND (error_code='ai_not_configured' OR (error_code IN ('daily_limit','subscription_sharing_usage_limit_exceeded') AND available_at<=?))`,time,aiConfigured(env)?1:0,time),
 ]);
 const jobs=await rows<Job>(env,`SELECT * FROM reflection_jobs WHERE state='pending' AND available_at<=? AND (dispatched_at IS NULL OR dispatched_at<?) ORDER BY available_at LIMIT 10`,time,time-300000);
 for(const j of jobs){const claim=await stmt(env,`UPDATE reflection_jobs SET dispatched_at=? WHERE id=? AND state='pending' AND signature=? AND (dispatched_at IS NULL OR dispatched_at<?) RETURNING id`,time,j.id,j.signature,time-300000).first();if(!claim)continue;
  try{await env.HARVEST_QUEUE.send({reflection_job_id:j.id},{contentType:'json'});}catch{await stmt(env,"UPDATE reflection_jobs SET dispatched_at=NULL WHERE id=? AND state='pending'",j.id).run();}
 }
}
export async function processReflection(env:Env,jobId:string,fetcher?:typeof fetch){if(!automaticAI(env))return;
 const token=id(),job=await stmt(env,`UPDATE reflection_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND state='pending' AND available_at<=? RETURNING *`,token,now()+180000,jobId,now()).first<Job>();if(!job)return;
 try{
  const input=JSON.parse(job.input_json) as Input;
  const data=await call(env,input.captures[0]?.id||null, 'responses',env.OPENAI_MODEL,{model:env.OPENAI_MODEL,store:false,instructions:reflectionInstructions,input:job.input_json,max_output_tokens:1800,text:{format:{type:'json_schema',name:'reading_reflection_v1',strict:true,schema:reflectionSchema}}},fetcher);
  if(data.status==='incomplete')throw new AiError('incomplete_output');const blocks=(data.output||[]).flatMap(x=>x.content||[]);if(blocks.some(x=>x.type==='refusal'))throw new AiError('refused');
  let output:Output;try{output=validateReflection(JSON.parse(blocks.filter(x=>x.type==='output_text').map(x=>x.text).join('')),input) as Output;}catch{throw new AiError('invalid_reflection');}
  const current=await collect(env,job.scope,job.scope_key,(await stmt(env,'SELECT start_at FROM reflection_jobs WHERE id=?',job.id).first<number>('start_at'))!, (await stmt(env,'SELECT end_at FROM reflection_jobs WHERE id=?',job.id).first<number>('end_at'))!);
  if(await digest(JSON.stringify(current))!==job.signature){await stmt(env,"UPDATE reflection_jobs SET state='superseded',lease_token=NULL WHERE id=? AND lease_token=?",job.id,token).run();return;}
  let guard="EXISTS(SELECT 1 FROM reflection_jobs WHERE id=? AND signature=? AND lease_token=? AND state='running')";const args:(string|number|null)[]=[job.id,job.signature,token];
  for(const c of input.captures){guard+=' AND EXISTS(SELECT 1 FROM captures WHERE id=? AND version=?)';args.push(c.id,c.version);}
  for(const v of input.view_changes){guard+=' AND EXISTS(SELECT 1 FROM view_revisions WHERE view_id=? AND version=?)';args.push(v.id,v.version);}
  for(const r of input.relations){guard+=' AND EXISTS(SELECT 1 FROM current_graph_relations WHERE id=?)';args.push(r.id);}
  await env.DB.batch([
   stmt(env,`INSERT INTO reflections(id,scope,scope_key,signature,result,input_json,model,processing_version,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`,id(),job.scope,job.scope_key,job.signature,JSON.stringify(output),job.input_json,data.used_model||env.OPENAI_MODEL,'reflection-v1',now(),...args),
   stmt(env,`UPDATE reflection_jobs SET state='completed',error_code=NULL,lease_token=NULL WHERE id=? AND signature=? AND lease_token=? AND ${guard}`,job.id,job.signature,token,...args),
  ]);
 }catch(e){const safe=e instanceof AiError?e:new AiError('reflection_failed');const blocked=['ai_not_configured','daily_limit','subscription_reauth_required','subscription_sharing_usage_limit_exceeded','subscription_audio_unsupported'].includes(safe.code),tomorrow=new Date();tomorrow.setUTCHours(24,0,0,0);
  await stmt(env,`UPDATE reflection_jobs SET state=?,error_code=?,dispatched_at=NULL,lease_token=NULL,available_at=? WHERE id=? AND signature=? AND lease_token=?`,blocked?'blocked':safe.retryable&&job.attempts<3?'pending':'failed',safe.code,['daily_limit','subscription_sharing_usage_limit_exceeded'].includes(safe.code)?tomorrow.getTime():now()+1000*2**job.attempts,job.id,job.signature,token).run();
 }
}
export async function listReflections(env:Env){
 const raw=await rows<{id:string;scope:Scope;scope_key:string;result:string;input_json:string;created_at:number}>(env,`SELECT r.* FROM reflections r JOIN reflection_jobs j ON j.scope=r.scope AND j.scope_key=r.scope_key AND j.signature=r.signature WHERE j.state='completed' ORDER BY r.created_at DESC LIMIT 10`);
 const valid=[];for(const r of raw){const input=JSON.parse(r.input_json) as Input;let okay=true;for(const c of input.captures){const v=await stmt(env,'SELECT version FROM captures WHERE id=?',c.id).first<number>('version');if(v!==c.version||(r.scope==='session'&&!await stmt(env,'SELECT capture_id FROM reading_session_members WHERE capture_id=? AND session_id=?',c.id,r.scope_key).first())){okay=false;break;}}if(okay)valid.push({...r,result:JSON.parse(r.result) as Output,input_json:undefined});}
 const current=[];for(const r of valid)if(await referencesCurrent(env,JSON.parse(raw.find(x=>x.id===r.id)!.input_json) as Input))current.push(r);
 return [current.find(r=>r.scope==='session'),current.find(r=>r.scope!=='session')].filter(Boolean);
}
export async function getReflection(env:Env,reflectionId:string){
 const r=await stmt(env,`SELECT r.* FROM reflections r JOIN reflection_jobs j ON j.scope=r.scope AND j.scope_key=r.scope_key AND j.signature=r.signature WHERE r.id=? AND j.state='completed'`,reflectionId).first<{id:string;scope:Scope;scope_key:string;result:string;input_json:string;created_at:number}>();if(!r)return null;
 const input=JSON.parse(r.input_json) as Input;for(const c of input.captures){if(await stmt(env,'SELECT version FROM captures WHERE id=?',c.id).first<number>('version')!==c.version||(r.scope==='session'&&!await stmt(env,'SELECT capture_id FROM reading_session_members WHERE capture_id=? AND session_id=?',c.id,r.scope_key).first()))return null;}
 if(!await referencesCurrent(env,input))return null;
 return {...r,result:JSON.parse(r.result) as Output,input,input_json:undefined};
}
export async function revisit(env:Env){
 const candidates=await rows<{id:string;question:string;concept_name:string}>(env,`SELECT DISTINCT c.id,json_extract(n.payload,'$.text') AS question,k.text AS concept_name FROM current_graph_nodes n JOIN captures c ON c.id=n.capture_id JOIN current_graph_nodes k ON k.capture_id=c.id AND k.kind='concept' JOIN concept_mentions m ON m.node_id=k.id LEFT JOIN revisit_state rs ON rs.capture_id=c.id WHERE n.kind='question' AND c.created_at<? AND COALESCE(rs.hidden,0)=0 AND (rs.last_shown_at IS NULL OR rs.last_shown_at<?)
 AND EXISTS(SELECT 1 FROM concept_mentions recent JOIN current_graph_nodes rn ON rn.id=recent.node_id JOIN captures rc ON rc.id=rn.capture_id WHERE recent.concept_id=m.concept_id AND rc.created_at>=? AND rc.id<>c.id) ORDER BY c.created_at DESC LIMIT 1`,now()-7*day,now()-30*day,now()-7*day);
 return candidates.map(c=>({...c,reason:`最近の「${c.concept_name}」と同じ意味の概念を含む、以前の問いです。`}));
}

export async function splitSession(env:Env,sessionId:string,captureId:string){
 const anchor=await stmt(env,`SELECT c.created_at FROM captures c JOIN reading_session_members m ON m.capture_id=c.id WHERE c.id=? AND m.session_id=?`,captureId,sessionId).first<{created_at:number}>();if(!anchor)return false;
 const newSession=id();
 await env.DB.batch([
  stmt(env,`INSERT INTO reading_sessions(id,source_id,started_at,ended_at,inferred) SELECT ?,source_id,?,ended_at,0 FROM reading_sessions WHERE id=?`,newSession,anchor.created_at,sessionId),
  stmt(env,`UPDATE reading_session_members SET session_id=?,manual=1 WHERE session_id=? AND capture_id IN(SELECT id FROM captures WHERE created_at>=?)`,newSession,sessionId,anchor.created_at),
  stmt(env,`UPDATE reading_sessions SET started_at=(SELECT min(c.created_at) FROM captures c JOIN reading_session_members m ON m.capture_id=c.id WHERE m.session_id=?),ended_at=(SELECT max(c.created_at) FROM captures c JOIN reading_session_members m ON m.capture_id=c.id WHERE m.session_id=?) WHERE id=? AND EXISTS(SELECT 1 FROM reading_session_members WHERE session_id=?)`,sessionId,sessionId,sessionId,sessionId),
 ]);
 await scheduleReflections(env,captureId);
 const old=await stmt(env,'SELECT started_at,ended_at FROM reading_sessions WHERE id=?',sessionId).first<{started_at:number;ended_at:number}>();if(old)await scheduleScope(env,'session',sessionId,old.started_at,old.ended_at,now()+300000);
 return true;
}
export async function readRevisit(env:Env){
 const date=periodBounds(now(),'day').key;
 const cached=await stmt(env,"SELECT value FROM settings WHERE key='revisit_today'").first<{value:string}>();
 if(cached){const item=JSON.parse(cached.value) as {date:string;item:{id:string;question:string;concept_name:string;reason:string}};if(item.date===date){const eligible=await stmt(env,`SELECT c.id FROM captures c JOIN current_graph_nodes n ON n.capture_id=c.id AND n.kind='question' LEFT JOIN revisit_state rs ON rs.capture_id=c.id WHERE c.id=? AND COALESCE(rs.hidden,0)=0 LIMIT 1`,item.item.id).first();return eligible?[item.item]:[];}}
 const candidates=await revisit(env);if(!candidates.length)return [];
 const item=candidates[0];
 await env.DB.batch([
  stmt(env,`INSERT INTO revisit_state(capture_id,last_shown_at,shown_count) VALUES(?,?,1) ON CONFLICT(capture_id) DO UPDATE SET last_shown_at=excluded.last_shown_at,shown_count=shown_count+1`,item.id,now()),
  stmt(env,"INSERT OR REPLACE INTO settings(key,value) VALUES('revisit_today',?)",JSON.stringify({date,item})),
 ]);return [item];
}
