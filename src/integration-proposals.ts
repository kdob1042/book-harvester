import {cancellationCleanup,isOperationCanceled,AIOperationCanceled,throwIfOperationCanceled,commitAIResult,nestedOperation} from './ai-cancellation.ts';
import {stmt,rows,fail,digest,id,now,text} from './core.ts';
import {integrateRecords} from './discovery.ts';
import {capturePages,themeMaterial,current,type Material} from './knowledge-materials.ts';
import {respond} from './ai-response.ts';
import {createShortlistIndex} from './classification.js';
import {proposalSchema,proposalInstructions,hasProposalHypothesis} from './integration-proposal-contract.js';
export async function readProposals(env:Env,runId?:string){
 const run=runId?await stmt(env,'SELECT * FROM integration_proposal_runs WHERE id=?',runId).first<any>():await stmt(env,'SELECT * FROM integration_proposal_runs ORDER BY created_at DESC,rowid DESC LIMIT 1').first<any>();
 if(!run){if(runId)fail(404,'統合案がありません。');return null;}
 const proposals=await rows<any>(env,'SELECT * FROM integration_proposals WHERE run_id=? ORDER BY position',run.id);
 return {...run,proposals:proposals.map(p=>({...p,materials:JSON.parse(p.materials_json),result:p.result_json?JSON.parse(p.result_json):null}))};
}
export function proposalConflict(a:any,b:any){const aa=a.materials||JSON.parse(a.materials_json),bb=b.materials||JSON.parse(b.materials_json);return Boolean(a.destination_id&&(a.destination_id===b.destination_id||bb.some((m:any)=>m.id===a.destination_id))||b.destination_id&&aa.some((m:any)=>m.id===b.destination_id));}
export async function generateProposals(env:Env,args:Record<string,unknown>,fetcher?:typeof fetch){
 const key=text(args.idempotency_key,100),hash=await digest(JSON.stringify(args));const old=await stmt(env,'SELECT * FROM integration_proposal_runs WHERE request_key=?',key).first<any>();if(old){if(old.request_hash!==hash)fail(409,'idempotency_conflict');return readProposals(env,old.id);}
 const run=id();const claim=await stmt(env,"INSERT OR IGNORE INTO integration_proposal_runs VALUES(?,?,?,'running',NULL,?)",run,key,hash,now()).run();if(!claim.meta.changes)return readProposals(env,(await stmt(env,'SELECT id FROM integration_proposal_runs WHERE request_key=?',key).first<any>()).id);
 try{
 const pool:Material[]=[];for await(const page of capturePages(env))pool.push(...page);
 for(const t of await rows<any>(env,"SELECT t.id FROM themes t JOIN theme_syntheses s ON s.theme_id=t.id WHERE t.state='active' AND NOT EXISTS(SELECT 1 FROM knowledge_inputs k JOIN theme_syntheses ps ON ps.revision_id=k.parent_revision WHERE k.child_kind='theme' AND k.child_id=t.id)")){try{pool.push(await themeMaterial(env,t.id));}catch{/* stale questions excluded */}}
 // Same lexical/domain/lens shortlist; score all years, bound the AI payload.
 const shortlist=createShortlistIndex(pool),byId=new Map(pool.map(m=>[m.id,m]));
 const pairs=pool.flatMap(a=>(shortlist(a,5) as Material[]).map(b=>({a:a.id,b:b.id,score:(b as any).score||0}))).sort((a,b)=>b.score-a.score||a.a.localeCompare(b.a));
 const picked=new Map<string,Material>();for(const pair of pairs){for(const mid of [pair.a,pair.b])if(picked.size<30)picked.set(mid,byId.get(mid)!);}
 const candidates=[...picked.values()];let out:any={proposals:[]};if(candidates.length>=2)out=await respond(env,'integration_proposals_v1',proposalSchema,proposalInstructions, {candidates,scanned:pool.length},fetcher);
 if(!Array.isArray(out.proposals)||out.proposals.length>5)fail(502,'invalid_proposals');const statements=[];const seen=new Set<string>();
 for(const [position,p] of out.proposals.entries()){
 if(!Array.isArray(p.material_ids)||p.material_ids.length<2||p.material_ids.length>6||new Set(p.material_ids).size!==p.material_ids.length)fail(502,'invalid_proposals');
 const ms=p.material_ids.map((mid:string)=>candidates.find(m=>m.id===mid));if(ms.some((m:any)=>!m))fail(502,'invalid_proposals');
 for(const [field,limit] of [['question',200],['scope',1000],['exclusions',1000],['reason',300]] as const)if(typeof p[field]!=='string'||p[field].length>limit||(field!=='exclusions'&&!p[field].trim()))fail(502,'invalid_proposals');
 if(p.theme_id!==null&&(!ms.some((m:Material)=>m.kind==='theme'&&m.id===p.theme_id)||ms.some((m:Material)=>m.kind==='theme'&&m.id!==p.theme_id)))fail(502,'invalid_destination');
 if(!hasProposalHypothesis(p))continue;
 const sig=p.material_ids.slice().sort().join('|')+':'+p.theme_id;if(seen.has(sig))continue;seen.add(sig);for(const m of ms)await current(env,m);
 const target=p.theme_id?await stmt(env,'SELECT version FROM theme_syntheses WHERE theme_id=?',p.theme_id).first<any>():null;
 const discovery=id(),proposal=id();const found={candidates:ms.slice(1),destination:{theme_id:p.theme_id,question:p.question,content:`暫定仮説：${p.hypothesis}\n統合の示唆：${p.reason}\n反証となる観察：${p.falsifier}`,scope:p.scope,exclusions:p.exclusions},synthesis_version:target?.version||0,destination_version:ms.find((m:Material)=>m.id===p.theme_id)?.version||0};
 statements.push(stmt(env,"INSERT INTO discovery_runs VALUES(?,?,?,?,?,'completed',?,?,NULL,?)",discovery,proposal,await digest(sig),ms[0].id,ms[0].version,JSON.stringify({anchor:ms[0]}),JSON.stringify(found),now()));
 statements.push(stmt(env,"INSERT INTO integration_proposals(id,run_id,discovery_id,position,question,reason,materials_json,destination_id) VALUES(?,?,?,?,?,?,?,?)",proposal,run,discovery,position,p.question,p.reason,JSON.stringify(ms),p.theme_id));
 }
 statements.push(stmt(env,"UPDATE integration_proposal_runs SET state='completed' WHERE id=? AND state='running'",run));await commitAIResult(env,statements);return readProposals(env,run);
 }catch(e){const canceled=await isOperationCanceled(env);await stmt(cancellationCleanup(env),"UPDATE integration_proposal_runs SET state='failed',error=? WHERE id=? AND state='running'",canceled?new AIOperationCanceled().message:e instanceof Error?e.message:'proposal_failed',run).run();if(canceled)await throwIfOperationCanceled(env);throw e;}
}
export async function executeProposals(env:Env,args:Record<string,unknown>,fetcher?:typeof fetch){
 const run=await readProposals(env,String(args.run_id));const selected=args.selected_ids;if(!Array.isArray(selected)||!selected.length||selected.length>5||new Set(selected).size!==selected.length)fail(400,'統合案を選んでください。');
 const proposals=selected.map(pid=>run!.proposals.find((p:any)=>p.id===pid));if(proposals.some(p=>!p))fail(400,'保存した統合案を選んでください。');
 for(let i=0;i<proposals.length;i++)for(let j=i+1;j<proposals.length;j++)if(proposalConflict(proposals[i],proposals[j]))fail(409,'同じ問いを更新する案は一つずつ選んでください。');
 const lastActionable=proposals.findLastIndex(p=>p.state!=='completed'&&p.state!=='running'&&(p.state!=='failed'||args.retry));
 let finished=false;
 for(const [index,p] of proposals.entries()){await throwIfOperationCanceled(env);if(p.state==='completed'||p.state==='running')continue;if(p.state==='failed'&&!args.retry)continue;
 const attempt=p.attempt+1,key=`proposal:${p.id}:${attempt}`;
 const claim=await stmt(env,"UPDATE integration_proposals SET state='running',attempt=attempt+1,error=NULL WHERE id=? AND state=? AND attempt=?",p.id,p.state,p.attempt).run();if(!claim.meta.changes)continue;
 let final=false;
 try{
  // Finish the root with the final integration's result transaction. Earlier
  // successes stay nested, so Stop can still prevent the remaining proposals.
  final=index===lastActionable&&!await stmt(env,"SELECT 1 FROM integration_proposals WHERE run_id=? AND id<>? AND state IN ('failed','running')",run!.id,p.id).first();
  const result=await integrateRecords(final?env:nestedOperation(env),{discovery_id:p.discovery_id,selected_ids:p.materials.slice(1).map((m:any)=>m.id),idempotency_key:key},fetcher);
  if(result.state!=='completed')fail(409,'統合が完了していません。');
  // For the final item the root is already terminal. This copies only the
  // integration's committed result into its proposal receipt.
  await stmt(final?cancellationCleanup(env):env,"UPDATE integration_proposals SET state='completed',result_json=?,error=NULL WHERE id=? AND state='running' AND attempt=?",JSON.stringify(result),p.id,attempt).run();
  finished=final;
 }
 catch(e){
  // An integration may have committed just before stop won the aggregate operation.
  // Reconcile terminal bookkeeping from that exact saved attempt; never regenerate it.
  const cleanup=cancellationCleanup(env),saved=await stmt(cleanup,'SELECT id,state,result_json FROM integration_runs WHERE request_key=?',key).first<any>();
  const canceled=await isOperationCanceled(env);
  if(saved?.state==='completed'&&saved.result_json){await stmt(cleanup,"UPDATE integration_proposals SET state='completed',result_json=?,error=NULL WHERE id=? AND state='running' AND attempt=?",JSON.stringify({id:saved.id,state:saved.state,...JSON.parse(saved.result_json)}),p.id,attempt).run();finished=final;}
  else await stmt(cleanup,"UPDATE integration_proposals SET state='failed',error=? WHERE id=? AND state='running' AND attempt=?",canceled?new AIOperationCanceled().message:e instanceof Error?e.message:'integration_failed',p.id,attempt).run();
  if(canceled)await throwIfOperationCanceled(env);
 }
 if(finished)break;
 }
 const result=await readProposals(env,run!.id);
 if(!finished&&result&&!result.proposals.some((p:any)=>p.state==='failed'||p.state==='running'))await commitAIResult(env,[]);
 return result;
}
