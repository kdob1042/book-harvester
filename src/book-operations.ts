import {readDiscovery,integrateRecords} from './discovery.ts';
import {overview,recordEvidence,history,themeRelations} from './book-reads.ts';
import {readBookJob,changeBookJob,jobStages} from './book-jobs.ts';
import {setVisibility} from './book-visibility.ts';
import {searchKnowledge} from './book-search.ts';
import {proposeThemeChange,readThemeChange,applyThemeChange} from './theme-changes.ts';
import {fileOperation} from './book-files.ts';
import {themeContext,saveAnalysis,rebuildTheme,discover,exportRecords,saveViewProposal} from './book-actions.ts';
import {automaticAI} from './ai-policy.ts';
import {route} from './index.ts';
import {rows,stmt,fail,digest} from './core.ts';
import {toolSpecs} from './mcp-tools.ts';
async function executeBook(env:Env,ctx:ExecutionContext,name:string,a:Record<string,unknown>) {
  if(!toolSpecs.some(s=>s[0]===name))fail(404,'unknown_tool');
  if(name==='get_status')return {capabilities:{records:true,views:true,research:true,themes:true,attachments:true,analysis_drafts:true,explicit_discovery:true,explicit_synthesis:true,export:true},ai_policy:automaticAI(env)?'automatic_legacy':'explicit_only',stages:await jobStages(env),jobs:await rows(env,'SELECT state,count(*) AS count FROM jobs GROUP BY state')};
  if(name==='get_overview')return overview(env,a);
  if(name==='get_evidence')return recordEvidence(env,a);
  if(name==='get_history')return history(env,a);
  if(name==='get_relations'&&a.entity==='theme')return themeRelations(env,String(a.id));
  if(name==='get_job'&&['theme','graph','import'].includes(String(a.kind)))return readBookJob(env,a);
  if(['retry_job','cancel_job'].includes(name)&&['theme','graph'].includes(String(a.kind)))return changeBookJob(env,ctx,a,name==='cancel_job');
  if(name==='set_visibility')return setVisibility(env,a);
  if(name==='search_records')return searchKnowledge(env,a);
  if(name==='propose_theme_change')return proposeThemeChange(env,a);
  if(name==='get_theme_change')return readThemeChange(env,String(a.id));
  if(name==='apply_theme_change'||name==='undo_theme_change')return applyThemeChange(env,String(a.id),name==='undo_theme_change');
  if(['save_file','attach_file','start_import'].includes(name))return fileOperation(env,ctx,name,a);
  if(name==='get_operation')return await stmt(env,'SELECT state,result_json,created_at FROM book_operation_receipts WHERE operation_key=?',`${a.operation}:${a.idempotency_key}`).first()||{state:'not_found'};
  if(name==='get_theme_context')return themeContext(env,String(a.id));
  if(name==='save_view_proposal')return saveViewProposal(env,a);
  if(name==='save_analysis_draft')return saveAnalysis(env,a);
  if(name==='rebuild_theme')return rebuildTheme(env,ctx,a);
  if(name==='get_discovery')return readDiscovery(env,String(a.id));
  if(name==='integrate_records')return integrateRecords(env,a);
  if(name==='discover_relations')return discover(env,ctx,a);
  if(name==='export_records')return exportRecords(env,a);
  const rid=String(a.id||'');if(a.id&&!['get_theme','get_theme_context','get_history','revise_theme','correct_membership','adopt_theme_view','merge_theme'].includes(name)&&!/^[a-f0-9-]{36}$/.test(rid))fail(400,'invalid_id');
  let path='',method='GET';const body={...a};delete body.id;delete body.idempotency_key;delete body.kind;
  switch(name){
   case 'merge_theme':path=`/api/themes/${encodeURIComponent(rid)}/merge`;method='POST';break;
   case 'restore_view':path=`/api/views/${rid}`;method='PATCH';break;
   case 'propose_concept_change':path='/api/concept-edits';method='POST';break;
   case 'get_concept_change':path=`/api/concept-edits/${rid}`;break;
   case 'apply_concept_change':case 'undo_concept_change':path=`/api/concept-edits/${rid}/${name==='apply_concept_change'?'apply':'undo'}`;method='POST';break;
   case 'get_import':path=`/api/imports/${rid}`;break;
   case 'select_import_items':path=`/api/imports/${rid}/select`;method='POST';break;
   case 'get_domains':path='/api/themes';break;
   case 'get_theme':case 'get_theme_context':path=`/api/themes/${encodeURIComponent(rid)}`;break;
   case 'get_history':path=`/api/themes/${encodeURIComponent(rid)}/history`;break;
   case 'revise_theme':path=`/api/themes/${encodeURIComponent(rid)}`;method='PATCH';break;
   case 'correct_membership':path=`/api/themes/${encodeURIComponent(rid)}/overrides`;method='POST';break;
   case 'adopt_theme_view':path=`/api/themes/${encodeURIComponent(rid)}/proposals`;method='POST';break;
   case 'get_migration_status':path='/api/themes/migration';break;
   case 'manage_migration':path='/api/themes/migration';method='POST';break;
   case 'get_record':path=`/api/captures/${rid}`;break;
   case 'save_capture':path='/api/captures';method='POST';body.source=String(a.source||'');break;
   case 'revise_capture':path=`/api/captures/${rid}`;method='PATCH';break;
   case 'adopt_view':path=`/api/captures/${rid}/adopt`;method='POST';break;
   case 'get_view':path=`/api/views/${rid}`;break;
   case 'revise_view':path=`/api/views/${rid}`;method='PATCH';break;
   case 'get_relations':path=`/api/graph/neighborhood?capture_id=${rid}`;break;
   case 'get_job':path=a.kind==='research'?`/api/research/${rid}`:`/api/captures/${rid}`;break;
   case 'retry_job':path=a.kind==='research'?`/api/research/${rid}/retry`:`/api/captures/${rid}/retry`;method='POST';break;
   case 'start_research':path='/api/research';method='POST';break;
   case 'cancel_job':path=`/api/research/${rid}/cancel`;method='POST';break;
   case 'delete_capture':path=`/api/captures/${rid}`;method='DELETE';break;
   default:fail(400,'unsupported_operation');
  }
  const key=String(a.idempotency_key||'');const hex=await digest(`${name}:${key}`),op=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  const request=new Request(new URL(path,env.APP_ORIGIN),{method,headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json','idempotency-key':key,'x-operation-id':op},...method!=='GET'?{body:JSON.stringify(body)}:{}});
  const response=await route(request,env,ctx,true);const data=await response.json();return {status:response.status,data,url:env.APP_ORIGIN};
 }

export async function callBook(env:Env,ctx:ExecutionContext,name:string,a:Record<string,unknown>){
 const spec=toolSpecs.find(s=>s[0]===name);if(!spec)fail(404,'unknown_tool');if(spec[2]==='book:read'||name==='preview_delete')return executeBook(env,ctx,name,a);
 const key=String(a.idempotency_key||'');if(!/^[a-zA-Z0-9_-]{16,100}$/.test(key))fail(400,'invalid_idempotency_key');const operation=`${name}:${key}`,hash=await digest(JSON.stringify({...a,...a.file?{file:{...(a.file as Record<string,unknown>),download_url:undefined}}:{}}));
 const claim=await stmt(env,'INSERT OR IGNORE INTO book_operation_receipts(operation_key,request_hash,created_at) VALUES(?,?,?)',operation,hash,Date.now()).run();
 if(!claim.meta.changes){const old=await stmt(env,'SELECT * FROM book_operation_receipts WHERE operation_key=?',operation).first<{request_hash:string;state:string;result_json:string}>();if(old!.request_hash!==hash)fail(409,'idempotency_conflict');if(old!.state!=='completed')fail(409,'operation_in_progress_or_interrupted');return JSON.parse(old!.result_json);}
 try{const result=await executeBook(env,ctx,name,a);await stmt(env,"UPDATE book_operation_receipts SET state='completed',result_json=? WHERE operation_key=?",JSON.stringify(result),operation).run();return result;}catch(e){await stmt(env,"UPDATE book_operation_receipts SET state='interrupted' WHERE operation_key=? AND state='running'",operation).run();throw e;}
}
