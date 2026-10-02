import {suggestRelations,saveRelation,removeOpposition} from './question-relations.ts';
import {drilldown,saveDrilldown,addDrilldownCandidate} from './drilldown.ts';
import {callBook} from './book-operations.ts';
import {readDiscovery,latestDiscovery,integrateRecords} from './discovery.ts';
import {automaticAI,authorizeAI} from './ai-policy.ts';
import {themeContext,saveAnalysis,rebuildTheme,discover} from './book-actions.ts';
import {listThemes,readTheme,captureThemes,actThemeProposal,themeMigrationStatus,manageThemeMigration,editTheme,overrideTheme,mergeTheme} from './themes.ts';
import {aiConfigured,chatgptStatus,disconnectChatgpt} from './chatgpt.ts';
import {ownerScope,syncDelta,receiptStatement,replayReceipt} from './sync.ts';
import {semanticSearch} from './semantic.ts';
import {neighborhood,proposeConceptEdit,readConceptEdit,applyConceptEdit} from './exploration.ts';
import {startResearch,readResearch,cancelResearch,retryResearch} from './research.ts';
import {allowedHosts} from './external.ts';
import {Buffer} from 'node:buffer';
import {HttpError,fail,text,version,jsonBody,stmt,rows,getCapture,jobStatement,revisionStatement,id,now,type Capture,type Harvest,type Asset,type View,type QueueBody} from './core.ts';
import {loggedIn,login,logout,accessAuthorized} from './auth.ts';
import {captureInput,requestKey,stageAsset,type Input} from './input.ts';
import {dispatch,cleanup,consume} from './queue.ts';
import {storeCapture} from './capture-storage.ts';
import {answer,AiError} from './ai.ts';
import {readGraph,rebuildGraph} from './graph.ts';
import {scheduleReflections,listReflections,getReflection,readRevisit,splitSession} from './reflections.ts';
import {receiveImport,readImport,selectImport,deleteImportArchive,importOriginal,reorderImport} from './imports.ts';

const json=(data:unknown,status=200,headers:HeadersInit={})=>Response.json(data,{status,headers});
const has=(input:Record<string,unknown>,key:string)=>Object.hasOwn(input,key);
function headers(response:Response,env:Env){
 const result=new Response(response.body,response);
 result.headers.set('Cache-Control','no-store');result.headers.set('X-Content-Type-Options','nosniff');
 result.headers.set('Referrer-Policy','same-origin');
 result.headers.set('Content-Security-Policy',"default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
 result.headers.set('Permissions-Policy','camera=(self), microphone=(self), geolocation=()');
 if(env.APP_ORIGIN?.startsWith('https:'))result.headers.set('Strict-Transport-Security','max-age=31536000');return result;
}
async function list(env:Env,search:string,semanticIds:string[]=[],filters={source:'',year:'',origin:''}){
 const escaped=`%${search.replace(/[\\%_]/g,'\\$&')}%`;
 const data=await rows<Capture&{result:string|null;state:string;error_code:string|null;original_preview:string;ai_authorized:number}>(env,`SELECT c.id,c.kind,c.version,c.created_at,c.page,c.locator_certainty,c.source_inherited,
 s.title AS source_title,s.certainty AS source_certainty,j.state,j.error_code,h.result,substr(c.original_text,1,100) AS original_preview,
 EXISTS(SELECT 1 FROM explicit_ai_actions a WHERE a.kind='harvest' AND a.target_id=c.id AND a.version=c.version) AS ai_authorized
 FROM captures c LEFT JOIN sources s ON s.id=c.source_id LEFT JOIN jobs j ON j.capture_id=c.id AND j.version=c.version
 LEFT JOIN harvests h ON h.capture_id=c.id AND h.version=c.version
 WHERE NOT EXISTS(SELECT 1 FROM capture_visibility v WHERE v.capture_id=c.id AND v.hidden=1) AND (c.id IN(SELECT value FROM json_each(?)) OR ?='' OR c.original_text LIKE ? ESCAPE '\\' OR c.note LIKE ? ESCAPE '\\' OR h.result LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\'
 OR EXISTS(SELECT 1 FROM current_graph_nodes n WHERE n.capture_id=c.id AND (n.text LIKE ? ESCAPE '\\' OR n.payload LIKE ? ESCAPE '\\'))
 OR EXISTS(SELECT 1 FROM current_graph_relations r WHERE r.capture_id=c.id AND r.payload LIKE ? ESCAPE '\\'))
 AND (?='' OR s.title LIKE ? ESCAPE '\\') AND (?='' OR substr(s.published_at,1,4)=?)
 AND (?='' OR c.import_origin=? OR EXISTS(SELECT 1 FROM json_each(h.result,'$.claims') WHERE json_extract(value,'$.evidence.origin')=?))
 ORDER BY c.created_at DESC,c.rowid DESC LIMIT 100`,JSON.stringify(semanticIds),search,escaped,escaped,escaped,escaped,escaped,escaped,escaped,filters.source,`%${filters.source.replace(/[\\%_]/g,'\\$&')}%`,filters.year,filters.year,filters.origin,filters.origin,filters.origin);
 return data.map(({result,...c})=>({...c,harvest:result?JSON.parse(result) as Harvest:null}));
}
function assetStatement(env:Env,captureId:string,objectKey:string,input:Input,key:string|null,mutation:string){
 if(!input.asset)throw new Error('asset_missing');
 return stmt(env,`INSERT INTO assets(id,capture_id,object_key,name,mime,size,request_key,request_hash,created_at)
 SELECT ?,id,?,?,?,?,?,?,? FROM captures WHERE id=? AND mutation_id=?`,id(),objectKey,input.asset.name,input.asset.mime,input.asset.bytes.length,key,input.hash,now(),captureId,mutation);
}
async function saveCapture(request:Request,env:Env){
 const result=await storeCapture(env,requestKey(request),await captureInput(request));return json(result,result.duplicate?200:201);
}
async function editCapture(request:Request,env:Env,captureId:string){
 const c=await getCapture(env,captureId);if(!c)fail(404,'記録が見つかりません。');
 const input=await jsonBody(request.clone()),base=version(input.version),mutation=id(),time=now();
 if(c.version!==base)fail(409,'記録が更新されています。開き直してください。');
 const corrected=has(input,'corrected_text')?(input.corrected_text===null?null:text(input.corrected_text)):c.corrected_text,note=has(input,'note')?text(input.note):c.note;
 const sourceTitle=has(input,'source_title')?text(input.source_title,500).trim():null,page=has(input,'page')?text(input.page,100)||null:c.page;
 const statements:D1PreparedStatement[]=[];
 if(sourceTitle)statements.push(stmt(env,`INSERT OR IGNORE INTO sources(id,title,certainty,created_at) SELECT ?,?,'explicit',? WHERE EXISTS(SELECT 1 FROM captures WHERE id=? AND version=?)`,id(),sourceTitle,time,captureId,base));
 const sourceExpression=sourceTitle!==null?'(SELECT id FROM sources WHERE title=?)':'source_id';
 const values:(string|number|null)[]=[corrected,note];if(sourceTitle!==null)values.push(sourceTitle);
 values.push(sourceTitle!==null?1:c.source_locked,sourceTitle!==null?0:c.source_inherited,page,sourceTitle!==null?'explicit':c.locator_certainty,mutation,time,captureId,base);
 const updateIndex=statements.length;
 statements.push(stmt(env,`UPDATE captures SET corrected_text=?,note=?,source_id=${sourceExpression},source_locked=?,source_inherited=?,page=?,locator_certainty=?,
 version=version+1,mutation_id=?,updated_at=? WHERE id=? AND version=?`,...values));
 statements.push(revisionStatement(env,captureId,mutation),jobStatement(env,captureId,base+1,mutation));
 if(sourceTitle!==null){
  statements.push(stmt(env,`DELETE FROM settings WHERE key='current_source' AND EXISTS(SELECT 1 FROM captures WHERE id=? AND mutation_id=? AND source_id IS NULL)`,captureId,mutation));
  statements.push(stmt(env,`INSERT OR REPLACE INTO settings(key,value) SELECT 'current_source',source_id FROM captures WHERE id=? AND mutation_id=? AND source_id IS NOT NULL`,captureId,mutation));
 }
 const receipt=await receiptStatement(env,request,'EXISTS(SELECT 1 FROM captures WHERE id=? AND mutation_id=?)',[captureId,mutation],{ok:true,id:captureId,version:base+1});if(receipt)statements.push(receipt);
 const result=await env.DB.batch(statements);
 if(!result[updateIndex].meta.changes)fail(409,'記録が更新されています。開き直してください。');
 return json(await getCapture(env,captureId));
}
async function supplement(request:Request,env:Env,captureId:string){
 const key=requestKey(request),input=await captureInput(request),base=version(request.headers.get('x-capture-version'));
 if(!input.asset)fail(400,'補足する写真か音声を選んでください。');
 const prior=await stmt(env,'SELECT capture_id,request_hash FROM assets WHERE request_key=?',key).first<{capture_id:string;request_hash:string}>();
 if(prior){if(prior.capture_id!==captureId||prior.request_hash!==input.hash)fail(409,'保存内容が一致しません。');return json(await getCapture(env,captureId));}
 const c=await getCapture(env,captureId);if(!c)fail(404,'記録が見つかりません。');
 if(c.version!==base)fail(409,'記録が更新されています。開き直してください。');
 if(c.assets.length>=4||c.assets.reduce((n,a)=>n+a.size,0)+input.asset.bytes.length>20*1024*1024)fail(400,'一つの記録には4ファイル・合計20MBまで補足できます。');
 const objectKey=await stageAsset(env,key,input);if(!objectKey)throw new Error('asset_missing');
 const mutation=id();
 const result=await env.DB.batch([
  stmt(env,`UPDATE captures SET version=version+1,mutation_id=?,updated_at=? WHERE id=? AND version=?`,mutation,now(),captureId,base),
  assetStatement(env,captureId,objectKey,input,key,mutation),
  stmt(env,'DELETE FROM staged_uploads WHERE object_key=? AND EXISTS(SELECT 1 FROM assets WHERE object_key=?)',objectKey,objectKey),
  revisionStatement(env,captureId,mutation),jobStatement(env,captureId,base+1,mutation),
 ]);
 if(!result[0].meta.changes){
  const duplicate=await stmt(env,'SELECT request_hash FROM assets WHERE request_key=? AND capture_id=?',key,captureId).first<{request_hash:string}>();
  if(duplicate?.request_hash!==input.hash)fail(409,'記録が更新されています。開き直してください。');
 }
 return json(await getCapture(env,captureId),201);
}
async function adopt(request:Request,env:Env,captureId:string){
 const input=await jsonBody(request.clone()),c=await getCapture(env,captureId);if(!c)fail(404,'記録が見つかりません。');
 const base=version(input.version);if(c.version!==base)fail(409,'解析結果が更新されています。開き直してください。');
 const draft=c.harvest?.view_draft;if(!draft)fail(409,'採用できる見方の案がありません。');
 const key=`${captureId}:${base}`,viewId=id(),time=now();
 const refs={capture_id:captureId,capture_version:base,claim_ids:draft.claim_ids,source_title:c.source_title,page:c.page,asset_ids:c.assets.map(a=>a.id),harvest_snapshot:c.harvest};
 await env.DB.batch([
  stmt(env,`INSERT OR IGNORE INTO views(id,capture_id,draft_key,title,body,version,created_at)
   SELECT ?,id,?,?,?,1,? FROM captures WHERE id=? AND version=?`,viewId,key,c.harvest!.summary.slice(0,80),draft.text,time,captureId,base),
  stmt(env,`INSERT OR IGNORE INTO view_revisions(view_id,version,body,reason,references_json,created_at)
   SELECT id,1,?,?,?,? FROM views WHERE id=?`,draft.text,draft.reason,JSON.stringify(refs),time,viewId),
 ]);
 const saved=await stmt(env,'SELECT id FROM views WHERE draft_key=?',key).first<{id:string}>();
 if(!saved)fail(409,'解析結果が更新されています。開き直してください。');return json(saved,201);
}
async function adoptProposal(request:Request,env:Env,captureId:string){
 const input=await jsonBody(request.clone()),proposalId=text(input.proposal_id,100),c=await getCapture(env,captureId);
 if(!c||c.version!==version(input.version))fail(409,'資料が更新されています。開き直してください。');
 const p=await stmt(env,`SELECT p.*,g.capture_id,g.version AS capture_version FROM view_proposals p JOIN graph_generations g ON g.id=p.generation_id WHERE p.id=? AND g.capture_id=?`,proposalId,captureId).first<{id:string;generation_id:string;view_id:string;base_version:number;from_text:string;to_text:string;reason:string;references_json:string;status:string}>();
 if(!p)fail(404,'提案が見つかりません。');
 if(p.status==='adopted')return json({id:p.view_id,duplicate:true});
 const v=await stmt(env,'SELECT * FROM views WHERE id=?',p.view_id).first<View>();
 if(!v||v.version!==p.base_version||v.body.split(p.from_text).length!==2){
  if(automaticAI(env))await rebuildGraph(env,[captureId]);fail(409,'見方が更新されたため、現行版を読み直してください。');
 }
 const body=v.body.replace(p.from_text,p.to_text),time=now();
 const prior=await stmt(env,'SELECT references_json FROM view_revisions WHERE view_id=? AND version=?',v.id,v.version).first<{references_json:string}>();
 const old=JSON.parse(prior?.references_json||'{}'),refs=JSON.parse(p.references_json);
 const deps=new Map<string,number>();
 for(const r of [...(old.dependencies||[]),...(old.capture_id?[{capture_id:old.capture_id,version:old.capture_version}]:[]),...refs.dependencies,{capture_id:c.id,version:c.version}])deps.set(r.capture_id,r.version);
 refs.dependencies=[...deps].map(([capture_id,version])=>({capture_id,version}));refs.previous_view_revision={view_id:v.id,version:v.version};
 const guard=`EXISTS(SELECT 1 FROM current_graph_generations WHERE id=?) AND EXISTS(SELECT 1 FROM view_proposals WHERE id=? AND status='pending')`;
 const saved=await env.DB.batch([
  stmt(env,`INSERT INTO view_revisions(view_id,version,body,reason,references_json,created_at) SELECT id,version+1,?,?,?,? FROM views WHERE id=? AND version=? AND ${guard}`,body,p.reason,JSON.stringify(refs),time,v.id,p.base_version,p.generation_id,p.id),
  stmt(env,`UPDATE views SET body=?,version=version+1 WHERE id=? AND version=? AND ${guard} AND EXISTS(SELECT 1 FROM view_revisions WHERE view_id=? AND version=? AND references_json=?)`,body,v.id,p.base_version,p.generation_id,p.id,v.id,p.base_version+1,JSON.stringify(refs)),
  stmt(env,`UPDATE view_proposals SET status='adopted' WHERE id=? AND EXISTS(SELECT 1 FROM views WHERE id=? AND version=?) AND EXISTS(SELECT 1 FROM view_revisions WHERE view_id=? AND version=? AND references_json=?)`,p.id,v.id,p.base_version+1,v.id,p.base_version+1,JSON.stringify(refs)),
  stmt(env,`INSERT OR REPLACE INTO graph_overrides(capture_id,item_key,action,created_at) SELECT ?,?,'adopted',? WHERE EXISTS(SELECT 1 FROM view_proposals WHERE id=? AND status='adopted')`,c.id,`proposal:${p.view_id}:${p.from_text}:${p.to_text}`,time,p.id),
 ]);
 if(!saved[1].meta.changes)fail(409,'資料か見方が更新されました。開き直してください。');return json({id:v.id},201);
}
async function evidenceStatus(env:Env,reference:Record<string,unknown>){
 const deps=Array.isArray(reference.dependencies)?reference.dependencies as {capture_id:string;version:number}[]:[];
 if(typeof reference.capture_id==='string')deps.push({capture_id:reference.capture_id,version:Number(reference.capture_version)});
 const issues=[];
 for(const d of deps){const c=await stmt(env,'SELECT version FROM captures WHERE id=?',d.capture_id).first<{version:number}>();if(!c||c.version!==d.version)issues.push({capture_id:d.capture_id,state:c?'changed':'deleted'});}
 return issues;
}
async function editView(request:Request,env:Env,viewId:string){
 const input=await jsonBody(request.clone()),v=await stmt(env,'SELECT * FROM views WHERE id=?',viewId).first<View>();if(!v)fail(404,'見方が見つかりません。');
 const base=version(input.version);if(v.version!==base)fail(409,'見方が更新されています。開き直してください。');
 const restore=has(input,'restore_version')?version(input.restore_version):base;
 const reference=await stmt(env,'SELECT * FROM view_revisions WHERE view_id=? AND version=?',viewId,restore).first<{body:string;references_json:string}>();
 if(!reference)fail(400,'復元する版がありません。');
 const body=has(input,'restore_version')?reference.body:text(input.body).trim(),reason=has(input,'restore_version')?`第${restore}版へ復元`:text(input.reason,2000).trim();
 if(!body||!reason)fail(400,'見方の本文と変更理由を残してください。');
 // Insert revision first, conditionally on the current version. A concurrent edit makes both writes no-ops.
 const receipt=await receiptStatement(env,request,'EXISTS(SELECT 1 FROM view_revisions WHERE view_id=? AND version=? AND body=? AND reason=?)',[viewId,base+1,body,reason],{ok:true,id:viewId,version:base+1});
 const result=await env.DB.batch([
  stmt(env,`INSERT INTO view_revisions(view_id,version,body,reason,references_json,created_at)
   SELECT id,version+1,?,?,?,? FROM views WHERE id=? AND version=?`,body,reason,reference.references_json,now(),viewId,base),
  stmt(env,'UPDATE views SET body=?,version=version+1 WHERE id=? AND version=?',body,viewId,base),
  ...(receipt?[receipt]:[]),
 ]);
 if(!result[1].meta.changes)fail(409,'見方が更新されています。開き直してください。');return json({ok:true});
}
async function deleteCapture(request:Request,env:Env,captureId:string){
 const input=await jsonBody(request.clone()),base=version(input.version);
 const receipt=await receiptStatement(env,request,'EXISTS(SELECT 1 FROM capture_tombstones WHERE capture_id=? AND version=?)',[captureId,base],{ok:true});
 const result=await env.DB.batch([
  stmt(env,`INSERT OR IGNORE INTO object_deletions(object_key,created_at) SELECT a.object_key,? FROM assets a JOIN captures c ON c.id=a.capture_id WHERE c.id=? AND c.version=?`,now(),captureId,base),
  stmt(env,`UPDATE import_items SET state='deleted',selected=0,error_code=NULL WHERE capture_id=? AND EXISTS(SELECT 1 FROM captures WHERE id=? AND version=?)`,captureId,captureId,base),
  stmt(env,'DELETE FROM captures WHERE id=? AND version=?',captureId,base),
  stmt(env,"DELETE FROM settings WHERE key='current_source' AND value IN (SELECT id FROM sources WHERE id NOT IN(SELECT source_id FROM captures WHERE source_id IS NOT NULL))"),
  stmt(env,'DELETE FROM sources WHERE id NOT IN(SELECT source_id FROM captures WHERE source_id IS NOT NULL)'),
  stmt(env,'DELETE FROM concepts WHERE id NOT IN(SELECT concept_id FROM concept_mentions) AND id NOT IN(SELECT concept_id FROM concept_overrides)'),
  stmt(env,`DELETE FROM reflection_jobs WHERE NOT EXISTS(SELECT 1 FROM captures WHERE id=?) AND EXISTS(SELECT 1 FROM json_each(input_json,'$.captures') WHERE json_extract(value,'$.id')=?)`,captureId,captureId),
  stmt(env,`DELETE FROM reflections WHERE NOT EXISTS(SELECT 1 FROM captures WHERE id=?) AND EXISTS(SELECT 1 FROM json_each(input_json,'$.captures') WHERE json_extract(value,'$.id')=?)`,captureId,captureId),
  stmt(env,'DELETE FROM reading_sessions WHERE id NOT IN(SELECT session_id FROM reading_session_members)'),
  ...(receipt?[receipt]:[]),
 ]);
 if(!result[2].meta.changes)fail(409,'記録が更新されています。開き直してください。');
 await env.DB.batch([stmt(env,"UPDATE external_source_index SET deleted=1 WHERE capture_id IS NULL"),stmt(env,"UPDATE research_materials SET state='deleted',body=NULL WHERE capture_id IS NULL AND state='saved'"),stmt(env,"UPDATE research_materials SET state='deleted',body=NULL WHERE state='duplicate' AND content_hash IN(SELECT content_hash FROM research_materials WHERE state='deleted')"),stmt(env,"UPDATE research_runs SET result_json=NULL WHERE id IN(SELECT run_id FROM research_materials WHERE state='deleted')"),stmt(env,"UPDATE research_runs SET question='元の記録は削除済み',result_json=NULL,state='superseded',lease_token=NULL WHERE capture_id IS NULL AND capture_version IS NOT NULL")]);
 // Deletion intent is durable even if R2 temporarily fails. Private download routes already stop resolving.
 try{await cleanup(env);}catch{return json({ok:true,originals_pending:true});}return json({ok:true});
}

// Original files are exported one at a time rather than accumulated into Worker memory.
function exportData(env:Env){
 const encoder=new TextEncoder();
 const stream=new ReadableStream<Uint8Array>({async start(controller){
  try{
   controller.enqueue(encoder.encode(`{"format":"book-harvester/v1","exported_at":${JSON.stringify(new Date().toISOString())}`));
   for(const table of ['question_oppositions','question_relation_runs','question_relation_choices','question_relations','drilldown_runs','drilldown_choices','knowledge_inputs','discovery_runs','integration_runs','sources','captures','capture_revisions','harvests','answers','views','view_revisions','asset_transcripts','assets','graph_jobs','graph_generations','graph_nodes','concepts','concept_mentions','graph_relations','graph_dependencies','view_proposals','graph_overrides','reading_sessions','reading_session_members','reflection_jobs','reflections','revisit_state','import_jobs','import_items','bibliography_jobs','research_runs','research_materials','external_source_index','embeddings','embedding_jobs','concept_overrides','concept_edits','capture_tombstones','sync_events','domains','lenses','themes','theme_domains','theme_memberships','theme_revisions','theme_syntheses','synthesis_evidence','theme_claim_relations','theme_relations','theme_view_links','theme_overrides','theme_proposals','theme_history','theme_dependencies','theme_member_lenses','theme_analysis_drafts','theme_changes','capture_visibility']){
    controller.enqueue(encoder.encode(`,${JSON.stringify(table)}:[`));let offset=0,first=true;
    while(true){
     const records=await rows<Record<string,unknown>>(env,`SELECT * FROM ${table} ORDER BY rowid LIMIT 50 OFFSET ?`,offset);
     for(const record of records){
      if(table==='captures'){delete record.request_key;delete record.request_hash;delete record.mutation_id;}
      if((table==='assets'||table==='import_jobs'||table==='import_items')&&record.object_key){
       const object=await env.ORIGINALS.get(String(record.object_key));if(!object)throw new Error('export_original_missing');
       record.base64=Buffer.from(await object.arrayBuffer()).toString('base64');delete record.object_key;delete record.request_key;delete record.request_hash;
      }
      if(['harvests','answers','graph_generations'].includes(table))record.result=JSON.parse(String(record.result));
      if(table==='graph_generations')record.input_snapshot=JSON.parse(String(record.input_snapshot));
      if(table==='graph_nodes'||table==='graph_relations')record.payload=JSON.parse(String(record.payload));
      if(table==='graph_jobs'||table==='reflection_jobs'){delete record.lease_token;}
      if(table==='import_jobs'){delete record.request_key;delete record.request_hash;delete record.lease_token;record.metadata_json=JSON.parse(String(record.metadata_json));}
      if(table==='research_runs'){delete record.request_key;delete record.request_hash;delete record.lease_token;}
      if(table==='reflections'){record.result=JSON.parse(String(record.result));}
      if(table==='reflections'||table==='reflection_jobs'){record.input_json=JSON.parse(String(record.input_json));}
      if(table==='view_revisions'||table==='view_proposals'){record.references=JSON.parse(String(record.references_json));delete record.references_json;}
      controller.enqueue(encoder.encode(`${first?'':','}${JSON.stringify(record)}`));first=false;
     }
     if(records.length<50)break;offset+=50;
    }
    controller.enqueue(encoder.encode(']'));
   }
   controller.enqueue(encoder.encode('}'));controller.close();
  }catch{controller.error(new Error('Export interrupted. Retry without simultaneous edits.'));}
 }});
 return new Response(stream,{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="book-harvester-export.json"'}});
}

export async function route(request:Request,env:Env,ctx:ExecutionContext,trustedService=false):Promise<Response>{
 const url=new URL(request.url),path=url.pathname,method=request.method;
 // Public bootstrap contains only the UI authentication mode, never identity or records.
 if(path==='/api/auth-config'&&method==='GET')return json({auth_method:env.ACCESS_AUD?'cloudflare_access':'password'},200,{'Cache-Control':'no-store'});
 if(!trustedService&&env.ACCESS_AUD&&!await accessAuthorized(env,ctx,request))fail(403,'Cloudflareで本人のアカウントにログインしてください。');
 if(!['GET','HEAD'].includes(method)&&request.headers.get('origin')!==env.APP_ORIGIN)fail(403,'この画面から操作し直してください。');
 if(path==='/healthz'&&method==='GET')return json({ok:true});
 if(path==='/api/login'&&method==='POST'){
  if(env.ACCESS_AUD)return json({ok:true});
  const result=await login(request,env,(await jsonBody(request.clone())).password);
  return json(result.status===200?{ok:true}:{error:result.error},result.status,result.cookie?{'Set-Cookie':result.cookie}:{});
 }
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
 if(!trustedService&&!env.ACCESS_AUD&&!await loggedIn(request,env))fail(401,'ログインしてください。');
 const replay=await replayReceipt(env,request);if(replay)return json(replay);
 const relation=/^\/api\/themes\/([^/]+)\/relationships(?:\/(save|remove))?$/.exec(path);if(relation&&method==='POST')return json(await (relation[2]==='save'?saveRelation:relation[2]==='remove'?removeOpposition:suggestRelations)(env,decodeURIComponent(relation[1]),await jsonBody(request.clone())));
 const drill=/^\/api\/themes\/([^/]+)\/drilldown(?:\/(save|candidates))?$/.exec(path);if(drill&&method==='POST')return json(await (drill[2]==='candidates'?addDrilldownCandidate:drill[2]?saveDrilldown:drilldown)(env,decodeURIComponent(drill[1]),await jsonBody(request.clone())));
 if(path==='/api/book/integrate'&&method==='POST')return json(await integrateRecords(env,await jsonBody(request.clone())));
 if(path==='/api/book/discovery'&&method==='GET')return json(url.searchParams.has('id')?await readDiscovery(env,url.searchParams.get('id')!):await latestDiscovery(env,url.searchParams.get('anchor')!));
 if(path==='/api/book/discover'&&method==='POST')return json(await callBook(env,ctx,'discover_relations',await jsonBody(request.clone())),202);
 const themeAction=/^\/api\/themes\/([^/]+)\/(context|analysis|rebuild)$/.exec(path);if(themeAction){const a={...await (method==='GET'?Promise.resolve({}):jsonBody(request.clone())),id:decodeURIComponent(themeAction[1])};if(themeAction[2]==='context'&&method==='GET')return json(await themeContext(env,a.id));if(themeAction[2]==='analysis'&&method==='POST')return json(await callBook(env,ctx,'save_analysis_draft',a),201);if(themeAction[2]==='rebuild'&&method==='POST')return json(await callBook(env,ctx,'rebuild_theme',a),202);}
 if(path==='/api/theme-changes'&&method==='POST')return json(await callBook(env,ctx,'propose_theme_change',await jsonBody(request.clone())),201);
 const themeChange=/^\/api\/theme-changes\/([a-f0-9-]{36})(?:\/(apply|undo))?$/.exec(path);if(themeChange){if(!themeChange[2]&&method==='GET')return json(await callBook(env,ctx,'get_theme_change',{id:themeChange[1]}));if(themeChange[2]&&method==='POST')return json(await callBook(env,ctx,themeChange[2]==='apply'?'apply_theme_change':'undo_theme_change',{...await jsonBody(request.clone()),id:themeChange[1]}));}
 if(path==='/api/book/visibility'&&method==='POST')return json(await callBook(env,ctx,'set_visibility',await jsonBody(request.clone())));
 if(path==='/api/themes/migration'&&method==='GET')return json(await themeMigrationStatus(env));
 if(path==='/api/themes/migration'&&method==='POST'){const r=await manageThemeMigration(env,await jsonBody(request.clone()));ctx.waitUntil(dispatch(env));return json(r);}
 if(path==='/api/themes'&&method==='GET')return json(await listThemes(env));
 const themeMatch=/^\/api\/themes\/([^/]+)(?:\/(proposals|history|overrides|merge))?$/.exec(path);
 if(themeMatch){const themeId=decodeURIComponent(themeMatch[1]);if(!themeMatch[2]&&method==='PATCH')return json(await editTheme(env,themeId,await jsonBody(request.clone())));if(themeMatch[2]==='merge'&&method==='POST')return json(await mergeTheme(env,themeId,await jsonBody(request.clone())));if(themeMatch[2]==='overrides'&&method==='POST')return json(await overrideTheme(env,themeId,await jsonBody(request.clone())));if(!themeMatch[2]&&method==='GET')return json(await readTheme(env,themeId));if(themeMatch[2]==='history'&&method==='GET'){const detail=await readTheme(env,themeId);return json(await rows(env,'SELECT * FROM theme_revisions WHERE theme_id=? ORDER BY version DESC LIMIT 20',themeId));}if(themeMatch[2]==='proposals'&&method==='POST')return json(await actThemeProposal(env,themeId,await jsonBody(request.clone())));}
 if(path==='/api/sync'&&method==='GET')return json(await syncDelta(env,url.searchParams.get('cursor')));
 if(path==='/api/logout'&&method==='POST')return json({ok:true,...(env.ACCESS_AUD?{redirect:'/cdn-cgi/access/logout'}:{})},200,{'Set-Cookie':await logout(request,env)});
 if(path==='/api/ai-activity'&&method==='GET'){
  const active=await stmt(env,`SELECT count(*) AS n FROM (SELECT state,created_at FROM ai_calls ORDER BY rowid DESC LIMIT 20) WHERE state='started' AND created_at>?`,now()-120000).first<number>('n');
  return json({active:Boolean(active),count:active||0});
 }
 if(path==='/api/state'&&method==='GET'){
  const day=new Date().toISOString().slice(0,10),search=(url.searchParams.get('q')||'').slice(0,200),semantic=await semanticSearch(env,search),filters={source:(url.searchParams.get('source')||'').slice(0,200),year:/^\d{4}$/.test(url.searchParams.get('year')||'')?url.searchParams.get('year')!:'',origin:['source','user','ai'].includes(url.searchParams.get('origin')||'')?url.searchParams.get('origin')!:''};
  const [captures,views,current,usage,reflections,revisits,imports]=await Promise.all([
   list(env,search,semantic.matches.map(x=>x.capture_id),filters),rows<View>(env,'SELECT * FROM views ORDER BY created_at DESC LIMIT 100'),
   stmt(env,"SELECT s.* FROM sources s JOIN settings t ON t.value=s.id WHERE t.key='current_source'").first(),
   stmt(env,'SELECT calls FROM ai_daily WHERE day=?',day).first<{calls:number}>(),
   listReflections(env),readRevisit(env),
   rows(env,'SELECT id,name,format,state,error_code FROM import_jobs ORDER BY created_at DESC LIMIT 10'),
  ]);
  const ai=await chatgptStatus(env);return json({scope:await ownerScope(env),auth_method:env.ACCESS_AUD?'cloudflare_access':'password',ai_configured:ai.mode==='chatgpt'?ai.state==='connected':aiConfigured(env),ai,captures:search?captures.sort((a,b)=>(semantic.matches.find(x=>x.capture_id===b.id)?.score||0)-(semantic.matches.find(x=>x.capture_id===a.id)?.score||0)):captures,filter_active:Boolean(filters.source||filters.year||filters.origin),search_state:semantic.state,semantic_matches:semantic.matches,views,reflections,revisits,imports,research:await rows(env,'SELECT id,question,state FROM research_runs ORDER BY created_at DESC LIMIT 10'),current_source:current,usage:{calls:usage?.calls||0},daily_limit:Number(env.AI_DAILY_CALL_LIMIT),theme_index:await listThemes(env)});
 }
 if(path==='/api/captures'&&method==='POST'){
  const saved=await saveCapture(request,env);ctx.waitUntil(dispatch(env));return saved;
 }
 const match=/^\/api\/captures\/([a-f0-9-]{36})(?:\/(assets|extract|retry|adopt|ask|proposal|hide))?$/.exec(path);
 if(match){
  const [,captureId,action]=match;
  if(!action&&method==='GET'){const c=await getCapture(env,captureId);if(!c)fail(404,'記録が見つかりません。');const aiAuthorized=Boolean(await stmt(env,"SELECT 1 FROM explicit_ai_actions WHERE kind='harvest' AND target_id=? AND version=?",c.id,c.version).first());return json({...c,ai_authorized:aiAuthorized,membership_job:await stmt(env,"SELECT id,version,state,error_code FROM theme_jobs WHERE kind='membership' AND target_id=? AND version=?",c.id,c.version).first(),themes:await captureThemes(env,c.id),graph:await readGraph(env,c.id,c.version),import_ref:await stmt(env,'SELECT i.job_id,i.ordinal,i.locator,j.name FROM import_items i JOIN import_jobs j ON j.id=i.job_id WHERE i.capture_id=?',c.id).first(),bibliography:c.source_bibliography?JSON.parse(c.source_bibliography):null});}
  if(!action&&method==='PATCH'){const saved=await editCapture(request,env,captureId);ctx.waitUntil(dispatch(env));return saved;}
  if(!action&&method==='DELETE')return deleteCapture(request,env,captureId);
  if(action==='assets'&&method==='POST'){const saved=await supplement(request,env,captureId);ctx.waitUntil(dispatch(env));return saved;}
  if(action==='adopt'&&method==='POST'){const saved=await adopt(request,env,captureId);ctx.waitUntil(scheduleReflections(env,captureId).then(()=>dispatch(env)));return saved;}
  if(action==='proposal'&&method==='POST'){
   try{const saved=await adoptProposal(request,env,captureId);ctx.waitUntil(scheduleReflections(env,captureId).then(()=>dispatch(env)));return saved;}catch(e){ctx.waitUntil(dispatch(env));throw e;}
  }
  if(action==='hide'&&method==='POST'){
   const input=await jsonBody(request.clone()),c=await getCapture(env,captureId);if(!c||c.version!==version(input.version))fail(409,'資料が更新されています。');
   const graph=await readGraph(env,c.id,c.version),key=text(input.item_key,5000);
   const discovery=graph.discoveries.find(d=>d.item_key===key||`discovery:${d.text}`===key);
   const allowed=[...graph.discoveries.map(d=>d.item_key),...(graph.proposal?[`proposal:${graph.proposal.view_id}:${graph.proposal.from_text}:${graph.proposal.to_text}`]:[])];
   if(!discovery&&!allowed.includes(key))fail(400,'表示中の案を選んでください。');
   await stmt(env,"INSERT OR REPLACE INTO graph_overrides(capture_id,item_key,action,created_at) SELECT ?,?,'hidden',? WHERE EXISTS(SELECT 1 FROM captures WHERE id=? AND version=?)",c.id,discovery?.item_key||key,now(),c.id,c.version).run();return json({ok:true});
  }
  if(action==='ask'&&method==='POST'){
   const input=await jsonBody(request.clone()),c=await getCapture(env,captureId);
   if(!c?.harvest)fail(409,'読み取りが完了した記録から質問してください。');
   if(c.version!==version(input.version))fail(409,'資料が更新されています。開き直してください。');
   const question=text(input.question,1000).trim();if(!question)fail(400,'質問を入力してください。');
   const result=await answer(env,c,c.harvest,question);
   const saved=await stmt(env,`INSERT INTO answers(id,capture_id,version,question,result,created_at) SELECT ?,id,version,?,?,? FROM captures WHERE id=? AND version=?`,id(),question,JSON.stringify(result),now(),captureId,c.version).run();
   if(!saved.meta.changes)fail(409,'回答中に資料が更新されました。開き直してください。');
   return json({...result,capture_id:c.id,capture_version:c.version});
  }
  if(action==='extract'&&method==='POST'){
   const input=await jsonBody(request.clone()),c=await getCapture(env,captureId);
   if(!c||c.version!==version(input.version))fail(409,'記録が更新されています。開き直してください。');
   const job=await stmt(env,'SELECT state FROM jobs WHERE capture_id=? AND version=?',c.id,c.version).first<{state:string}>();if(!job)fail(409,'読み取り対象がありません。');
   await authorizeAI(env,'harvest',c.id,c.version);
   if(job.state==='blocked'||job.state==='failed')await stmt(env,"UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=?,dispatched_at=NULL WHERE capture_id=? AND version=?",now(),c.id,c.version).run();
   ctx.waitUntil(dispatch(env));return json({ok:true},202);
  }
  if(action==='retry'&&method==='POST'){
   const input=await jsonBody(request.clone());
   const change=await stmt(env,`UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=?,dispatched_at=NULL
    WHERE capture_id=? AND version=? AND version=(SELECT version FROM captures WHERE id=?) AND state IN('blocked','failed')`,now(),captureId,version(input.version),captureId).run();
   if(!change.meta.changes)fail(409,'記録が更新されたか、処理中です。');await authorizeAI(env,'harvest',captureId,version(input.version));ctx.waitUntil(dispatch(env));return json({ok:true});
  }
 }
 const assetMatch=/^\/api\/assets\/([a-f0-9-]{36})$/.exec(path);
 if(assetMatch&&method==='GET'){
  const asset=await stmt(env,'SELECT * FROM assets WHERE id=?',assetMatch[1]).first<Asset>();if(!asset)fail(404,'原資料が見つかりません。');
  const object=await env.ORIGINALS.get(asset.object_key);if(!object)fail(404,'原資料が見つかりません。');
  return new Response(object.body,{headers:{'Content-Type':asset.mime,'Content-Length':String(object.size),'Content-Disposition':`inline; filename="${asset.name}"`}});
 }
 const viewMatch=/^\/api\/views\/([a-f0-9-]{36})$/.exec(path);
 if(viewMatch){
  if(method==='GET'){
   const v=await stmt(env,'SELECT * FROM views WHERE id=?',viewMatch[1]).first<View>();if(!v)fail(404,'見方が見つかりません。');
   const revisions=await rows<Record<string,unknown>>(env,'SELECT * FROM view_revisions WHERE view_id=? ORDER BY version DESC',v.id);
   const references=JSON.parse(String(revisions[0]?.references_json||'{}'));
   return json({...v,evidence_issues:await evidenceStatus(env,references),revisions:revisions.map(r=>({...r,references:JSON.parse(String(r.references_json)),references_json:undefined}))});
  }
  if(method==='PATCH'){const saved=await editView(request,env,viewMatch[1]);ctx.waitUntil(scheduleReflections(env,(await stmt(env,'SELECT capture_id FROM views WHERE id=?',viewMatch[1]).first<string>('capture_id'))!).then(()=>dispatch(env)));return saved;}
 }
 if(path==='/api/ai/disconnect'&&method==='POST'){await disconnectChatgpt(env);return json({ok:true});}
 if(path==='/api/graph/neighborhood'&&method==='GET')return json(await neighborhood(env,url.searchParams.get('capture_id')||'',url.searchParams.get('focus')));
 if(path==='/api/concept-edits'&&method==='GET')return json(await rows(env,'SELECT id,action,reason,state,created_at FROM concept_edits ORDER BY created_at DESC LIMIT 20'));
 if(path==='/api/concept-edits'&&method==='POST')return json(await proposeConceptEdit(env,await jsonBody(request.clone())),201);
 const conceptMatch=/^\/api\/concept-edits\/([a-f0-9-]{36})(?:\/(apply|undo))?$/.exec(path);
 if(conceptMatch){if(!conceptMatch[2]&&method==='GET'){const e=await readConceptEdit(env,conceptMatch[1]);if(!e)fail(404,'整理案がありません。');return json(e);}if(method==='POST'&&conceptMatch[2]){const result=await applyConceptEdit(env,conceptMatch[1],conceptMatch[2]==='undo');ctx.waitUntil(dispatch(env));return json(result);}}
 if(path==='/api/graph/rebuild'&&method==='POST'){
  const input=await jsonBody(request.clone());if(!Array.isArray(input.capture_ids)||input.capture_ids.length<1||input.capture_ids.length>20||input.capture_ids.some(x=>typeof x!=='string'||!/^[-a-f0-9]{36}$/.test(x)))fail(400,'再構成する記録IDを1〜20件指定してください。');
  await rebuildGraph(env,input.capture_ids as string[]);ctx.waitUntil(dispatch(env));return json({ok:true},202);
 }
 const reflectionMatch=/^\/api\/reflections\/([a-f0-9-]{36})(?:\/(split))?$/.exec(path);
 if(reflectionMatch){
  const r=await getReflection(env,reflectionMatch[1]);if(!r)fail(404,'振り返りの根拠が更新されています。');
  if(!reflectionMatch[2]&&method==='GET')return json(r);
  if(reflectionMatch[2]==='split'&&method==='POST'){
   const input=await jsonBody(request.clone());if(r.scope!=='session'||!await splitSession(env,r.scope_key,text(input.capture_id,36)))fail(400,'区切りを分ける記録を選んでください。');ctx.waitUntil(dispatch(env));return json({ok:true});
  }
 }
 if(path==='/api/revisit/hide'&&method==='POST'){
  const input=await jsonBody(request.clone()),captureId=text(input.capture_id,36);if(!await getCapture(env,captureId))fail(404,'記録がありません。');await stmt(env,`INSERT INTO revisit_state(capture_id,hidden) VALUES(?,1) ON CONFLICT(capture_id) DO UPDATE SET hidden=1`,captureId).run();return json({ok:true});
 }
 if(path==='/api/research'&&method==='POST'){const saved=await startResearch(env,requestKey(request),await jsonBody(request.clone()));ctx.waitUntil(dispatch(env));return json(saved,202);}
 if(path==='/api/research/hosts'&&method==='GET')return json({hosts:allowedHosts(env)});
 const researchMatch=/^\/api\/research\/([a-f0-9-]{36})(?:\/(cancel|retry))?$/.exec(path);
 if(researchMatch){const r=await readResearch(env,researchMatch[1]);if(!r)fail(404,'調査がありません。');if(!researchMatch[2]&&method==='GET')return json(r);if(method==='POST'&&researchMatch[2]==='cancel'){await cancelResearch(env,r.id);return json({ok:true});}if(method==='POST'&&researchMatch[2]==='retry'){await retryResearch(env,r.id);ctx.waitUntil(dispatch(env));return json({ok:true});}}
 if(path==='/api/export'&&method==='GET')return exportData(env);
 if(path==='/api/imports'&&method==='POST'){const saved=await receiveImport(request,env);ctx.waitUntil(dispatch(env));return json(saved,saved.duplicate?200:201);}
 const importMatch=/^\/api\/imports\/([a-f0-9-]{36})(?:\/(select|retry|original|order)(?:\/(\d+))?)?$/.exec(path);
 if(importMatch){
  const job=await readImport(env,importMatch[1]);if(!job)fail(404,'取り込みがありません。');const action=importMatch[2];
  if(!action&&method==='GET')return json(job);
  if(action==='original'&&method==='GET'){const original=await importOriginal(env,job.id,importMatch[3]?Number(importMatch[3]):null);if(!original)fail(404,'原ファイルがありません。');return original;}
  if(action==='select'&&method==='POST'){const input=await jsonBody(request.clone());if(!Array.isArray(input.ordinals)||input.ordinals.some(n=>!Number.isInteger(n)))fail(400,'取り込む範囲を選んでください。');await selectImport(env,job.id,input.ordinals as number[]);ctx.waitUntil(dispatch(env));return json({ok:true},202);}
  if(action==='order'&&method==='POST'){const input=await jsonBody(request.clone());if(job.format!=='photos'||!Array.isArray(input.ordinals))fail(400,'写真番号を指定してください。');await reorderImport(env,job.id,input.ordinals as number[]);return json({ok:true});}
  if(action==='retry'&&method==='POST'){await env.DB.batch([stmt(env,"UPDATE import_items SET state='available',error_code=NULL WHERE job_id=? AND state='failed' AND capture_id IS NULL",job.id),stmt(env,"UPDATE import_jobs SET state='pending',attempts=0,error_code=NULL,available_at=?,dispatched_at=NULL WHERE id=? AND state IN('failed','partial')",now(),job.id)]);ctx.waitUntil(dispatch(env));return json({ok:true},202);}
  if(!action&&method==='DELETE'){
   await stmt(env,"UPDATE import_jobs SET state='canceled',lease_token=NULL WHERE id=?",job.id).run();
   const current=await readImport(env,job.id);
   for(const item of current?.items||[]){if(item.capture_id){const c=await getCapture(env,item.capture_id);if(c)await deleteCapture(new Request(request.url,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:c.version})}),env,c.id);}}
   await deleteImportArchive(env,job.id);ctx.waitUntil(cleanup(env));return json({ok:true});
  }
 }
 fail(404,'この操作は見つかりません。');
}

export default {
 async fetch(request,env,ctx){
  try{return headers(await route(request,env,ctx),env);}
  catch(e){
   const message=e instanceof HttpError?e.message:e instanceof AiError?(e.code==='daily_limit'?'今日のAI利用上限に達しました。':e.code==='ai_not_configured'?'AIの設定が必要です。':'資料について回答できませんでした。'):'操作を完了できませんでした。原資料を残したまま、もう一度お試しください。';
   const aiMessage=e instanceof AiError?(e.code==='subscription_reauth_required'?'ChatGPTへの再接続が必要です。':e.code==='subscription_sharing_usage_limit_exceeded'?'ChatGPTの利用上限に達しました。':`AI処理に失敗しました（${e.code}）。もう一度お試しください。`):message;
   return headers(json({error:e instanceof AiError&&!['daily_limit','ai_not_configured'].includes(e.code)?aiMessage:message,...e instanceof AiError?{error_code:e.code,retryable:e.retryable}:{}},e instanceof HttpError?e.status:e instanceof AiError?503:500),env);
  }
 },
 async scheduled(_event,env){await dispatch(env);await cleanup(env);},
 async queue(batch,env){await consume(batch,env);},
} satisfies ExportedHandler<Env>;
