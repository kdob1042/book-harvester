import {stmt,rows,getCapture,now,id,digest,type Harvest,type View} from './core.ts';
import {call,AiError} from './ai.ts';
import {graphSchema,graphInstructions,validateGraph} from './graph-contract.js';

type Proof={claim_id:string;quote:string|null};
type Relation={id:string;from_id:string;to_id:string;type:string;reason:string;conditions:string[];interpretation:string;evidence:Proof[]};
type GraphResult={
 claim_context:{claim_id:string;speaker:string|null;subject:string|null;scope:string;subject_period:string|null}[];
 concept_resolution:{concept_id:string;existing_id:string|null;decision:string;reason:string;aliases:string[]}[];
 relations:Relation[]; mechanisms:{id:string;text:string;claim_ids:string[];relation_ids:string[];conditions:string[];time_lag:string|null}[];
 discoveries:{relation_id:string;text:string;common_structure:string;important_difference:string}[];
 view_proposal:{view_id:string;base_version:number;from_text:string;to_text:string;reason:string;evidence:Proof[]}|null;
};
type Node={id:string;kind:string;capture_id:string;version:number;text:string;payload:Record<string,unknown>;canonical_id?:string;evidence?:Harvest['claims'][number]['evidence'];source_title:string|null;page:string|null};
type Candidates={nodes:Node[];views:View[]};
type GraphJob={id:string;capture_id:string;version:number;attempts:number;state:string;error_code:string|null};
const nodeId=(captureId:string,v:number,local:string)=>`${captureId}:${v}:${local}`;
// A hidden connection follows its grounded edge across regenerated wording/IDs.
// Changed source versions, direction, conditions, interpretation or evidence stay reviewable.
async function discoveryKey(relation:Relation){
 const normalize=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/g,' ');
 const conditions=[...new Set(relation.conditions.map(normalize))].sort();
 const evidence=relation.evidence.map(e=>[e.claim_id,e.quote===null?null:normalize(e.quote)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return `connection:${await digest(JSON.stringify([relation.from_id,relation.to_id,relation.type,relation.interpretation,conditions,evidence]))}`;
}
export function graphJobStatement(env:Env,captureId:string,v:number,guard='1',values:(string|number|null)[]=[]){
 return stmt(env,`INSERT OR IGNORE INTO graph_jobs(id,capture_id,version,available_at,created_at) SELECT ?,?,?,?,? WHERE ${guard}`,id(),captureId,v,now(),now(),...values);
}
export async function dispatchGraph(env:Env){
 const time=now();
 await env.DB.batch([
  stmt(env,`UPDATE graph_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error_code='worker_interrupted',dispatched_at=NULL,lease_token=NULL WHERE state='running' AND lease_until<?`,time),
  stmt(env,`UPDATE graph_jobs SET state='pending',error_code=NULL,dispatched_at=NULL,available_at=? WHERE state='blocked' AND ?=1 AND (error_code='ai_not_configured' OR (error_code='daily_limit' AND available_at<=?))`,time,env.OPENAI_API_KEY?1:0,time),
  stmt(env,`UPDATE graph_jobs SET state='pending',attempts=0,error_code=NULL,dispatched_at=NULL,available_at=? WHERE id IN(
   SELECT j.id FROM graph_jobs j JOIN captures c ON c.id=j.capture_id AND c.version=j.version
   JOIN graph_generations g ON g.capture_id=j.capture_id AND g.version=j.version AND g.active=1
   WHERE j.state='completed' AND (NOT EXISTS(SELECT 1 FROM current_graph_generations WHERE id=g.id)
    OR EXISTS(SELECT 1 FROM view_proposals p JOIN views v ON v.id=p.view_id WHERE p.generation_id=g.id AND p.status='pending' AND p.base_version<>v.version)) LIMIT 20)`,time),
 ]);
 const jobs=await rows<GraphJob>(env,`SELECT * FROM graph_jobs WHERE state='pending' AND available_at<=? AND (dispatched_at IS NULL OR dispatched_at<?) ORDER BY created_at LIMIT 20`,time,time-300000);
 for(const j of jobs){
  const claimed=await stmt(env,`UPDATE graph_jobs SET dispatched_at=? WHERE id=? AND state='pending' AND (dispatched_at IS NULL OR dispatched_at<?) RETURNING id`,time,j.id,time-300000).first();
  if(!claimed)continue;
  try{await env.HARVEST_QUEUE.send({graph_job_id:j.id},{contentType:'json'});}catch{await stmt(env,"UPDATE graph_jobs SET dispatched_at=NULL WHERE id=? AND state='pending'",j.id).run();}
 }
}

async function candidatesFor(env:Env,captureId:string,h:Harvest):Promise<Candidates>{
 // Bounded SQL retrieval: recent context plus up to four older semantic-label/summary hits.
 // Recent candidates are included regardless of shared words, so structure can bridge different terminology.
 const terms=[...h.concepts.map(k=>k.name),...h.questions.map(q=>q.text)].slice(0,6).map(x=>`%${x.slice(0,80).replace(/[\\%_]/g,'\\$&')}%`);
 const recent=await rows<{id:string}>(env,'SELECT id FROM current_graph_generations WHERE capture_id<>? ORDER BY created_at DESC LIMIT 8',captureId);
 const hits=terms.length?await rows<{id:string}>(env,`SELECT DISTINCT g.id FROM current_graph_generations g JOIN graph_nodes n ON n.generation_id=g.id WHERE g.capture_id<>? AND (${terms.map(()=>"n.text LIKE ? ESCAPE '\\'").join(' OR ')}) ORDER BY g.created_at DESC LIMIT 4`,captureId,...terms):[];
 const ids=[...new Set([...hits,...recent].map(x=>x.id))].slice(0,12);
 const raw=ids.length?await rows<{id:string;kind:string;capture_id:string;version:number;text:string;payload:string;canonical_id:string|null;source_title:string|null;page:string|null}>(env,`SELECT n.*,m.concept_id AS canonical_id,s.title AS source_title,c.page FROM current_graph_nodes n JOIN captures c ON c.id=n.capture_id LEFT JOIN sources s ON s.id=c.source_id LEFT JOIN concept_mentions m ON m.node_id=n.id WHERE n.generation_id IN(${ids.map(()=>'?').join(',')}) ORDER BY n.capture_id,n.kind,n.local_id LIMIT 468`,...ids):[];
 // Keep whole Capture groups; a truncated group could lose the claim backing a concept.
 const selected:typeof raw=[];
 for(const cap of new Set(raw.map(n=>n.capture_id))){const group=raw.filter(n=>n.capture_id===cap);if(selected.length+group.length<=120)selected.push(...group);}
 const nodes=selected.map(n=>({...n,canonical_id:n.canonical_id||undefined,payload:JSON.parse(n.payload) as Record<string,unknown>}));
 const views=await rows<View>(env,'SELECT * FROM views ORDER BY created_at DESC LIMIT 6');
 return {nodes,views};
}

export async function processGraphJob(env:Env,jobId:string,fetcher?:typeof fetch){
 const token=id();
 const job=await stmt(env,`UPDATE graph_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND state='pending' AND available_at<=? RETURNING *`,token,now()+180000,jobId,now()).first<GraphJob>();
 if(!job)return;
 try{
  const c=await getCapture(env,job.capture_id);
  if(!c?.harvest||c.version!==job.version){await stmt(env,"UPDATE graph_jobs SET state='superseded',lease_token=NULL WHERE id=? AND lease_token=?",jobId,token).run();return;}
  const h=c.harvest,candidates=await candidatesFor(env,c.id,h);
  const input={current:{capture_id:c.id,version:c.version,source_title:c.source_title,page:c.page,harvest:h},candidates};
  // Reject oversized contexts before the provider call, rather than silently clipping quotes/references.
  const serialized=JSON.stringify(input);if(serialized.length>180000)throw new AiError('graph_context_limit');
  const data=await call(env,c.id,'responses',env.OPENAI_MODEL,{model:env.OPENAI_MODEL,store:false,instructions:graphInstructions,input:serialized,max_output_tokens:Number(env.AI_MAX_OUTPUT_TOKENS),text:{format:{type:'json_schema',name:'knowledge_graph_v1',strict:true,schema:graphSchema}}},fetcher);
  if(data.status==='incomplete')throw new AiError('incomplete_output');
  const blocks=(data.output||[]).flatMap(o=>o.content||[]);if(blocks.some(b=>b.type==='refusal'))throw new AiError('refused');
  let result:GraphResult;try{result=validateGraph(JSON.parse(blocks.filter(b=>b.type==='output_text').map(b=>b.text).join('')),h,candidates) as GraphResult;}catch{throw new AiError('invalid_graph');}
  const generation=id(),remote=new Map(candidates.nodes.map(n=>[n.id,n]));
  const resolve=(ref:string)=>remote.has(ref)?ref:nodeId(c.id,c.version,ref);
  const used=new Set(result.relations.flatMap(r=>[r.from_id,r.to_id,...r.evidence.map(e=>e.claim_id)]).concat(result.mechanisms.flatMap(m=>m.claim_ids),result.view_proposal?.evidence.map(e=>e.claim_id)||[]));
  for(const k of result.concept_resolution){if(k.existing_id){const existing=candidates.nodes.find(n=>n.canonical_id===k.existing_id);if(existing)used.add(existing.id);}}
  const deps=new Map<string,number>();for(const ref of used){const n=remote.get(ref);if(n)deps.set(n.capture_id,n.version);}
  let guard=`EXISTS(SELECT 1 FROM graph_jobs j JOIN captures c ON c.id=j.capture_id WHERE j.id=? AND j.state='running' AND j.lease_token=? AND c.version=j.version)`;
  const guardValues:(string|number|null)[]=[jobId,token];
  for(const [cap,v] of deps){guard+=' AND EXISTS(SELECT 1 FROM captures WHERE id=? AND version=?)';guardValues.push(cap,v);}
  // A proposal based on a changed View is discarded and compared again; it never writes that View.
  if(result.view_proposal){guard+=' AND EXISTS(SELECT 1 FROM views WHERE id=? AND version=?)';guardValues.push(result.view_proposal.view_id,result.view_proposal.base_version);}
  const statements:D1PreparedStatement[]=[
   stmt(env,`UPDATE graph_generations SET active=0 WHERE capture_id=? AND version=? AND ${guard}`,c.id,c.version,...guardValues),
   stmt(env,`INSERT INTO graph_generations(id,capture_id,version,active,result,model,processing_version,input_snapshot,created_at) SELECT ?,?,?,1,?,?,?,?,? WHERE ${guard}`,generation,c.id,c.version,JSON.stringify(result),env.OPENAI_MODEL,'graph-v1',serialized,now(),...guardValues),
  ];
  const exists='EXISTS(SELECT 1 FROM graph_generations WHERE id=?)';
  for(const group of [{kind:'claim',items:h.claims},{kind:'concept',items:h.concepts},{kind:'question',items:h.questions}]){
   for(const item of group.items){
    const payload={...item,organized_by:'ai',...(group.kind==='claim'?result.claim_context.find(x=>x.claim_id===item.id):{}),claim_ids:'claim_ids' in item?item.claim_ids.map(resolve):undefined};
    const body='text' in item?item.text:'name' in item?item.name:'';
    statements.push(stmt(env,`INSERT INTO graph_nodes(id,generation_id,local_id,kind,text,payload) SELECT ?,?,?,?,?,? WHERE ${exists} ON CONFLICT(id) DO UPDATE SET generation_id=excluded.generation_id,text=excluded.text,payload=excluded.payload`,resolve(item.id),generation,item.id,group.kind,body,JSON.stringify(payload),generation));
   }
  }
  for(const k of h.concepts){
   const decision=result.concept_resolution.find(x=>x.concept_id===k.id)!;
   const canonical=decision.decision==='same_meaning'?decision.existing_id!:`concept:${await digest(`${k.name.normalize('NFKC').trim()}\n${k.description.normalize('NFKC').trim()}`)}`;
   // Exact name+definition duplicates are safe to reuse. Semantic reuse is recorded with its explanation.
   statements.push(stmt(env,`INSERT OR IGNORE INTO concepts(id,name,meaning,created_at) SELECT ?,?,?,? WHERE ${exists}`,canonical,k.name,k.description,now(),generation));
   statements.push(stmt(env,`INSERT INTO concept_mentions(node_id,concept_id,decision,reason,aliases) SELECT ?,?,?,?,? WHERE ${exists} ON CONFLICT(node_id) DO UPDATE SET concept_id=excluded.concept_id,decision=excluded.decision,reason=excluded.reason,aliases=excluded.aliases`,resolve(k.id),canonical,decision.decision,JSON.stringify({reason:decision.reason,possible_id:decision.decision==='possible'?decision.existing_id:null}),JSON.stringify(decision.aliases),generation));
  }
  for(const r of result.relations){const payload={...r,from_id:resolve(r.from_id),to_id:resolve(r.to_id),evidence:r.evidence.map(e=>({...e,claim_id:resolve(e.claim_id)}))};statements.push(stmt(env,`INSERT INTO graph_relations(id,generation_id,from_id,to_id,type,payload) SELECT ?,?,?,?,?,? WHERE ${exists}`,`${generation}:${r.id}`,generation,payload.from_id,payload.to_id,r.type,JSON.stringify(payload),generation));}
  for(const m of result.mechanisms){const payload={...m,claim_ids:m.claim_ids.map(resolve),relation_ids:m.relation_ids.map(x=>`${generation}:${x}`),organized_by:'ai'};statements.push(stmt(env,`INSERT INTO graph_nodes(id,generation_id,local_id,kind,text,payload) SELECT ?,?,?,'mechanism',?,? WHERE ${exists} ON CONFLICT(id) DO UPDATE SET generation_id=excluded.generation_id,text=excluded.text,payload=excluded.payload`,resolve(m.id),generation,m.id,m.text,JSON.stringify(payload),generation));}
  // Remove obsolete derived mechanisms after successful replacement, keeping historical results in generations.
  statements.push(stmt(env,`DELETE FROM graph_nodes WHERE id LIKE ? AND generation_id<>? AND kind='mechanism' AND ${exists}`,`${c.id}:${c.version}:%`,generation,generation));
  for(const [cap,v] of deps)statements.push(stmt(env,`INSERT INTO graph_dependencies(generation_id,capture_id,version) SELECT ?,?,? WHERE ${exists}`,generation,cap,v,generation));
  if(result.view_proposal){const p=result.view_proposal;const reference={capture_id:c.id,capture_version:c.version,generation_id:generation,harvest_snapshot:h,source_title:c.source_title,page:c.page,evidence:p.evidence.map(e=>({claim_id:resolve(e.claim_id),quote:e.quote,snapshot:remote.get(e.claim_id)||h.claims.find(x=>x.id===e.claim_id)})),dependencies:[...deps].map(([capture_id,version])=>({capture_id,version}))};
   statements.push(stmt(env,`INSERT INTO view_proposals(id,generation_id,view_id,base_version,from_text,to_text,reason,references_json,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${exists}`,generation,generation,p.view_id,p.base_version,p.from_text,p.to_text,p.reason,JSON.stringify(reference),now(),generation));
  }
  const finalIndex=statements.length;
  statements.push(stmt(env,`UPDATE graph_jobs SET state='completed',error_code=NULL,lease_token=NULL WHERE id=? AND lease_token=? AND ${exists}`,jobId,token,generation));
  const saved=await env.DB.batch(statements);
  if(!saved[finalIndex].meta.changes){
   await stmt(env,`UPDATE graph_jobs SET state=CASE WHEN version<>(SELECT version FROM captures WHERE id=capture_id) THEN 'superseded' WHEN attempts<3 THEN 'pending' ELSE 'failed' END,error_code='graph_context_changed',dispatched_at=NULL,lease_token=NULL,available_at=? WHERE id=? AND lease_token=?`,now(),jobId,token).run();
  }
 }catch(e){const safe=e instanceof AiError?e:new AiError('graph_processing_failed');const blocked=['ai_not_configured','daily_limit'].includes(safe.code);const tomorrow=new Date();tomorrow.setUTCHours(24,0,0,0);
  await stmt(env,`UPDATE graph_jobs SET state=?,error_code=?,available_at=?,dispatched_at=NULL,lease_token=NULL WHERE id=? AND lease_token=?`,blocked?'blocked':safe.retryable&&job.attempts<3?'pending':'failed',safe.code,safe.code==='daily_limit'?tomorrow.getTime():now()+1000*2**job.attempts,jobId,token).run();
 }
}

export async function readGraph(env:Env,captureId:string,v:number){
 const [job,g,overrides]=await Promise.all([
  stmt(env,'SELECT state,error_code FROM graph_jobs WHERE capture_id=? AND version=?',captureId,v).first<{state:string;error_code:string|null}>(),
  stmt(env,'SELECT * FROM current_graph_generations WHERE capture_id=? AND version=?',captureId,v).first<{id:string;result:string}>(),
  rows<{item_key:string;action:string}>(env,'SELECT item_key,action FROM graph_overrides WHERE capture_id=?',captureId),
 ]);
 if(!g)return {job,discoveries:[],mechanisms:[],proposal:null};
 const result=JSON.parse(g.result) as GraphResult,hidden=new Set(overrides.filter(x=>x.action==='hidden').map(x=>x.item_key));
 const valid=await rows<{payload:string}>(env,'SELECT payload FROM current_graph_relations WHERE generation_id=?',g.id);
 const remoteIds=[...new Set(valid.flatMap(r=>{const p=JSON.parse(r.payload) as Relation;return p.evidence.map(e=>e.claim_id);} ))];
 const evidence=remoteIds.length?await rows<{id:string;capture_id:string;version:number;text:string;payload:string;source_title:string|null;page:string|null}>(env,`SELECT n.*,s.title AS source_title,c.page FROM current_graph_nodes n JOIN captures c ON c.id=n.capture_id LEFT JOIN sources s ON s.id=c.source_id WHERE n.id IN(${remoteIds.map(()=>'?').join(',')})`,...remoteIds):[];
 const relations=new Map(valid.map(r=>{const p=JSON.parse(r.payload) as Relation;return [p.id,{...p,evidence:p.evidence.map(e=>({...e,...evidence.find(n=>n.id===e.claim_id),payload:undefined}))}];}));
 const discoveries=(await Promise.all(result.discoveries.filter(d=>relations.has(d.relation_id)).map(async d=>{
  const relation=relations.get(d.relation_id)!,item_key=await discoveryKey(relation);
  return {...d,item_key,relation};
 }))).filter(d=>!hidden.has(d.item_key)&&!hidden.has(`discovery:${d.text}`));
 const proposal=await stmt(env,`SELECT p.*,v.body,v.version AS current_version FROM view_proposals p JOIN views v ON v.id=p.view_id WHERE p.generation_id=? AND p.status='pending'`,g.id).first<{id:string;view_id:string;base_version:number;current_version:number;body:string;from_text:string;to_text:string;reason:string}>();
 const show=proposal&&!overrides.some(x=>x.item_key===`proposal:${proposal.view_id}:${proposal.from_text}:${proposal.to_text}`)?{...proposal,stale:proposal.current_version!==proposal.base_version,preview:proposal.body.replace(proposal.from_text,proposal.to_text)}:null;
 return {job:show?.stale&&job?.state==='completed'?{...job,state:'pending'}:job,generation_id:g.id,discoveries,mechanisms:result.mechanisms,proposal:show};
}

export async function rebuildGraph(env:Env,captureIds:string[]){
 if(captureIds.length<1||captureIds.length>20)throw new Error('rebuild_limit');
 // Same Harvest versions, stable node references. Old active generations remain until the new batch commits.
 for(const cap of captureIds){await stmt(env,`INSERT INTO graph_jobs(id,capture_id,version,available_at,created_at) SELECT ?,c.id,c.version,?,? FROM captures c JOIN harvests h ON h.capture_id=c.id AND h.version=c.version WHERE c.id=?
 ON CONFLICT(capture_id,version) DO UPDATE SET state='pending',attempts=0,error_code=NULL,available_at=excluded.available_at,dispatched_at=NULL WHERE graph_jobs.state NOT IN('running','pending')`,id(),now(),now(),cap).run();}
}
