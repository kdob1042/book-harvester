import {Buffer} from 'node:buffer';
import {HttpError,fail,text,version,jsonBody,stmt,rows,getCapture,jobStatement,revisionStatement,id,now,type Capture,type Harvest,type Asset,type View,type QueueBody} from './core.ts';
import {loggedIn,login,logout} from './auth.ts';
import {captureInput,requestKey,stageAsset,type Input} from './input.ts';
import {dispatch,cleanup,consume} from './queue.ts';
import {answer,AiError} from './ai.ts';

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
async function list(env:Env,search:string){
 const escaped=`%${search.replace(/[\\%_]/g,'\\$&')}%`;
 const data=await rows<Capture&{result:string|null;state:string;error_code:string|null;original_preview:string}>(env,`SELECT c.id,c.kind,c.version,c.created_at,c.page,c.locator_certainty,c.source_inherited,
 s.title AS source_title,s.certainty AS source_certainty,j.state,j.error_code,h.result,substr(c.original_text,1,100) AS original_preview
 FROM captures c LEFT JOIN sources s ON s.id=c.source_id LEFT JOIN jobs j ON j.capture_id=c.id AND j.version=c.version
 LEFT JOIN harvests h ON h.capture_id=c.id AND h.version=c.version
 WHERE ?='' OR c.original_text LIKE ? ESCAPE '\\' OR c.note LIKE ? ESCAPE '\\' OR h.result LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\'
 ORDER BY c.created_at DESC,c.rowid DESC LIMIT 100`,search,escaped,escaped,escaped,escaped);
 return data.map(({result,...c})=>({...c,harvest:result?JSON.parse(result) as Harvest:null}));
}
function assetStatement(env:Env,captureId:string,objectKey:string,input:Input,key:string|null,mutation:string){
 if(!input.asset)throw new Error('asset_missing');
 return stmt(env,`INSERT INTO assets(id,capture_id,object_key,name,mime,size,request_key,request_hash,created_at)
 SELECT ?,id,?,?,?,?,?,?,? FROM captures WHERE id=? AND mutation_id=?`,id(),objectKey,input.asset.name,input.asset.mime,input.asset.bytes.length,key,input.hash,now(),captureId,mutation);
}
async function saveCapture(request:Request,env:Env){
 const key=requestKey(request),input=await captureInput(request);
 const existing=await stmt(env,'SELECT id,request_hash FROM captures WHERE request_key=?',key).first<{id:string;request_hash:string}>();
 if(existing){if(existing.request_hash!==input.hash)fail(409,'同じ保存操作で異なる内容が届きました。');return json({id:existing.id,duplicate:true});}
 const objectKey=await stageAsset(env,key,input),captureId=id(),mutation=id();
 const current=await stmt(env,"SELECT value FROM settings WHERE key='current_source'").first<{value:string}>();
 const statements=[stmt(env,`INSERT INTO captures(id,request_key,request_hash,source_id,source_inherited,kind,original_text,note,mutation_id,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,captureId,key,input.hash,current?.value||null,current?1:0,input.asset?input.asset.mime.startsWith('image/')?'image':'audio':'text',input.text,input.note,mutation,now(),now())];
 if(objectKey)statements.push(assetStatement(env,captureId,objectKey,input,null,mutation),stmt(env,'DELETE FROM staged_uploads WHERE object_key=?',objectKey));
 statements.push(revisionStatement(env,captureId,mutation),jobStatement(env,captureId,1,mutation));
 try{await env.DB.batch(statements);}
 catch(e){
  const duplicate=await stmt(env,'SELECT id,request_hash FROM captures WHERE request_key=?',key).first<{id:string;request_hash:string}>();
  if(duplicate?.request_hash===input.hash)return json({id:duplicate.id,duplicate:true});
  if(duplicate)fail(409,'同じ保存操作で異なる内容が届きました。');throw e;
 }
 return json({id:captureId,duplicate:false},201);
}
async function editCapture(request:Request,env:Env,captureId:string){
 const c=await getCapture(env,captureId);if(!c)fail(404,'記録が見つかりません。');
 const input=await jsonBody(request),base=version(input.version),mutation=id(),time=now();
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
 const input=await jsonBody(request),c=await getCapture(env,captureId);if(!c)fail(404,'記録が見つかりません。');
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
async function editView(request:Request,env:Env,viewId:string){
 const input=await jsonBody(request),v=await stmt(env,'SELECT * FROM views WHERE id=?',viewId).first<View>();if(!v)fail(404,'見方が見つかりません。');
 const base=version(input.version);if(v.version!==base)fail(409,'見方が更新されています。開き直してください。');
 const restore=has(input,'restore_version')?version(input.restore_version):base;
 const reference=await stmt(env,'SELECT * FROM view_revisions WHERE view_id=? AND version=?',viewId,restore).first<{body:string;references_json:string}>();
 if(!reference)fail(400,'復元する版がありません。');
 const body=has(input,'restore_version')?reference.body:text(input.body).trim(),reason=has(input,'restore_version')?`第${restore}版へ復元`:text(input.reason,2000).trim();
 if(!body||!reason)fail(400,'見方の本文と変更理由を残してください。');
 // Insert revision first, conditionally on the current version. A concurrent edit makes both writes no-ops.
 const result=await env.DB.batch([
  stmt(env,`INSERT INTO view_revisions(view_id,version,body,reason,references_json,created_at)
   SELECT id,version+1,?,?,?,? FROM views WHERE id=? AND version=?`,body,reason,reference.references_json,now(),viewId,base),
  stmt(env,'UPDATE views SET body=?,version=version+1 WHERE id=? AND version=?',body,viewId,base),
 ]);
 if(!result[1].meta.changes)fail(409,'見方が更新されています。開き直してください。');return json({ok:true});
}
async function deleteCapture(request:Request,env:Env,captureId:string){
 const input=await jsonBody(request),base=version(input.version);
 const result=await env.DB.batch([
  stmt(env,`INSERT OR IGNORE INTO object_deletions(object_key,created_at) SELECT a.object_key,? FROM assets a JOIN captures c ON c.id=a.capture_id WHERE c.id=? AND c.version=?`,now(),captureId,base),
  stmt(env,'DELETE FROM captures WHERE id=? AND version=?',captureId,base),
  stmt(env,"DELETE FROM settings WHERE key='current_source' AND value IN (SELECT id FROM sources WHERE id NOT IN(SELECT source_id FROM captures WHERE source_id IS NOT NULL))"),
  stmt(env,'DELETE FROM sources WHERE id NOT IN(SELECT source_id FROM captures WHERE source_id IS NOT NULL)'),
 ]);
 if(!result[1].meta.changes)fail(409,'記録が更新されています。開き直してください。');
 // Deletion intent is durable even if R2 temporarily fails. Private download routes already stop resolving.
 try{await cleanup(env);}catch{return json({ok:true,originals_pending:true});}return json({ok:true});
}

// Original files are exported one at a time rather than accumulated into Worker memory.
function exportData(env:Env){
 const encoder=new TextEncoder();
 const stream=new ReadableStream<Uint8Array>({async start(controller){
  try{
   controller.enqueue(encoder.encode(`{"format":"book-harvester/v1","exported_at":${JSON.stringify(new Date().toISOString())}`));
   for(const table of ['sources','captures','capture_revisions','harvests','answers','views','view_revisions','asset_transcripts','assets']){
    controller.enqueue(encoder.encode(`,${JSON.stringify(table)}:[`));let offset=0,first=true;
    while(true){
     const records=await rows<Record<string,unknown>>(env,`SELECT * FROM ${table} ORDER BY rowid LIMIT 50 OFFSET ?`,offset);
     for(const record of records){
      if(table==='captures'){delete record.request_key;delete record.request_hash;delete record.mutation_id;}
      if(table==='assets'){
       const object=await env.ORIGINALS.get(String(record.object_key));if(!object)throw new Error('export_original_missing');
       record.base64=Buffer.from(await object.arrayBuffer()).toString('base64');delete record.object_key;delete record.request_key;delete record.request_hash;
      }
      if(table==='harvests'||table==='answers')record.result=JSON.parse(String(record.result));
      if(table==='view_revisions'){record.references=JSON.parse(String(record.references_json));delete record.references_json;}
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

async function route(request:Request,env:Env,ctx:ExecutionContext){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!['GET','HEAD'].includes(method)&&request.headers.get('origin')!==env.APP_ORIGIN)fail(403,'この画面から操作し直してください。');
 if(path==='/healthz'&&method==='GET')return json({ok:true});
 if(path==='/api/login'&&method==='POST'){
  const result=await login(request,env,(await jsonBody(request)).password);
  return json(result.status===200?{ok:true}:{error:result.error},result.status,result.cookie?{'Set-Cookie':result.cookie}:{});
 }
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
 if(!await loggedIn(request,env))fail(401,'ログインしてください。');
 if(path==='/api/logout'&&method==='POST')return json({ok:true},200,{'Set-Cookie':await logout(request,env)});
 if(path==='/api/state'&&method==='GET'){
  const day=new Date().toISOString().slice(0,10);
  const [captures,views,current,usage]=await Promise.all([
   list(env,(url.searchParams.get('q')||'').slice(0,200)),rows<View>(env,'SELECT * FROM views ORDER BY created_at DESC LIMIT 100'),
   stmt(env,"SELECT s.* FROM sources s JOIN settings t ON t.value=s.id WHERE t.key='current_source'").first(),
   stmt(env,'SELECT calls FROM ai_daily WHERE day=?',day).first<{calls:number}>(),
  ]);
  return json({ai_configured:Boolean(env.OPENAI_API_KEY),captures,views,current_source:current,usage:{calls:usage?.calls||0},daily_limit:Number(env.AI_DAILY_CALL_LIMIT)});
 }
 if(path==='/api/captures'&&method==='POST'){
  const saved=await saveCapture(request,env);ctx.waitUntil(dispatch(env));return saved;
 }
 const match=/^\/api\/captures\/([a-f0-9-]{36})(?:\/(assets|retry|adopt|ask))?$/.exec(path);
 if(match){
  const [,captureId,action]=match;
  if(!action&&method==='GET'){const c=await getCapture(env,captureId);if(!c)fail(404,'記録が見つかりません。');return json(c);}
  if(!action&&method==='PATCH'){const saved=await editCapture(request,env,captureId);ctx.waitUntil(dispatch(env));return saved;}
  if(!action&&method==='DELETE')return deleteCapture(request,env,captureId);
  if(action==='assets'&&method==='POST'){const saved=await supplement(request,env,captureId);ctx.waitUntil(dispatch(env));return saved;}
  if(action==='adopt'&&method==='POST')return adopt(request,env,captureId);
  if(action==='ask'&&method==='POST'){
   const input=await jsonBody(request),c=await getCapture(env,captureId);
   if(!c?.harvest)fail(409,'読み取りが完了した記録から質問してください。');
   if(c.version!==version(input.version))fail(409,'資料が更新されています。開き直してください。');
   const question=text(input.question,1000).trim();if(!question)fail(400,'質問を入力してください。');
   const result=await answer(env,c,c.harvest,question);
   const saved=await stmt(env,`INSERT INTO answers(id,capture_id,version,question,result,created_at) SELECT ?,id,version,?,?,? FROM captures WHERE id=? AND version=?`,id(),question,JSON.stringify(result),now(),captureId,c.version).run();
   if(!saved.meta.changes)fail(409,'回答中に資料が更新されました。開き直してください。');
   return json({...result,capture_id:c.id,capture_version:c.version});
  }
  if(action==='retry'&&method==='POST'){
   const input=await jsonBody(request);
   const change=await stmt(env,`UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=?,dispatched_at=NULL
    WHERE capture_id=? AND version=? AND version=(SELECT version FROM captures WHERE id=?) AND state IN('blocked','failed')`,now(),captureId,version(input.version),captureId).run();
   if(!change.meta.changes)fail(409,'記録が更新されたか、処理中です。');ctx.waitUntil(dispatch(env));return json({ok:true});
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
   return json({...v,revisions:revisions.map(r=>({...r,references:JSON.parse(String(r.references_json)),references_json:undefined}))});
  }
  if(method==='PATCH')return editView(request,env,viewMatch[1]);
 }
 if(path==='/api/export'&&method==='GET')return exportData(env);
 fail(404,'この操作は見つかりません。');
}

export default {
 async fetch(request,env,ctx){
  try{return headers(await route(request,env,ctx),env);}
  catch(e){
   const message=e instanceof HttpError?e.message:e instanceof AiError?(e.code==='daily_limit'?'今日のAI利用上限に達しました。':e.code==='ai_not_configured'?'AIの設定が必要です。':'資料について回答できませんでした。'):'操作を完了できませんでした。原資料を残したまま、もう一度お試しください。';
   return headers(json({error:message},e instanceof HttpError?e.status:e instanceof AiError?503:500),env);
  }
 },
 async scheduled(_event,env){await dispatch(env);await cleanup(env);},
 async queue(batch,env){await consume(batch,env);},
} satisfies ExportedHandler<Env>;
