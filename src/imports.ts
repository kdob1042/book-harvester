import {automaticAI} from './ai-policy.ts';
import {boundedBody,digest,stmt,rows,id,now,fail,type Asset} from './core.ts';
import {captureInput,requestKey,MAX_UPLOAD,type Input} from './input.ts';
import {startExtraction} from './extraction.ts';
import {storeCapture} from './capture-storage.ts';
import {parseDocument,type ParsedDocument} from './import-parsers.ts';
type ImportJob={id:string;format:string;name:string;object_key:string|null;state:string;attempts:number;metadata_json:string};
type Item={id:string;job_id:string;ordinal:number;locator:string|null;origin:string;body:string;note:string;object_key:string|null;mime:string|null;size:number|null;state:string;capture_id:string|null;selected:number};
export async function receiveImport(request:Request,env:Env){
 const key=requestKey(request),raw=await boundedBody(request,20*1024*1024+65536),type=request.headers.get('content-type')||'';
 if(!type.startsWith('multipart/form-data'))fail(415,'対応ファイルを選んでください。');
 const form=await new Request('http://localhost',{method:'POST',headers:{'Content-Type':type},body:raw}).formData(),files=form.getAll('file');
 if(!files.length||files.length>12||files.some(f=>!(f instanceof File)))fail(400,'1〜12ファイルを選んでください。');
 const uploads=[];let total=0;
 for(const value of files){const file=value as File;total+=file.size;if(file.size>MAX_UPLOAD||total>20*1024*1024)fail(413,'1ファイル10MB、合計20MBまでです。');const bytes=new Uint8Array(await file.arrayBuffer());uploads.push({bytes,name:file.name.replace(/[^\p{L}\p{N} ._-]/gu,'_').slice(0,150)||'document',mime:file.type});}
 const first=uploads[0],isPhotos=uploads.every(x=>x.mime.startsWith('image/'));
 const format=isPhotos?'photos':files.length!==1?'':first.name.toLowerCase().endsWith('.pdf')?'pdf':first.name.toLowerCase().endsWith('.epub')?'epub':first.name.toLowerCase().endsWith('.json')?'json':first.name.toLowerCase().endsWith('.txt')?'clippings':'';
 if(!format)fail(415,'写真、PDF、EPUB、対応JSON、My Clippings.txtを選んでください。');
 if(format==='pdf'&&new TextDecoder().decode(first.bytes.slice(0,5))!=='%PDF-'||format==='epub'&&!(first.bytes[0]===80&&first.bytes[1]===75))fail(415,'ファイル内容と形式が一致しません。');
 const hashes=await Promise.all(uploads.map(x=>digest(x.bytes))),hash=await digest(JSON.stringify({format,hashes}));
 const old=await stmt(env,'SELECT id,request_hash FROM import_jobs WHERE request_key=? OR request_hash=? ORDER BY request_key=? DESC LIMIT 1',key,hash,key).first<{id:string;request_hash:string}>();
 if(old){if(old.request_hash!==hash)fail(409,'同じ操作で異なるファイルが届きました。');return {id:old.id,duplicate:true};}
 const jobId=id(),statements:D1PreparedStatement[]=[],keys:string[]=[];
 for(let n=0;n<uploads.length;n++){
  const upload=uploads[n];let mime=format==='pdf'?'application/pdf':format==='epub'?'application/epub+zip':format==='json'?'application/json':format==='clippings'?'text/plain':upload.mime;
  if(isPhotos){const check=new FormData();check.set('file',new Blob([upload.bytes],{type:upload.mime}),upload.name);const checked=await captureInput(new Request('http://localhost',{method:'POST',body:check}));mime=checked.asset!.mime;}
  const objectKey=`imports/${jobId}/${n}`;keys.push(objectKey);
  await stmt(env,'INSERT OR IGNORE INTO staged_uploads VALUES(?,?)',objectKey,now()).run();await env.ORIGINALS.put(objectKey,upload.bytes,{httpMetadata:{contentType:mime}});
  if(isPhotos)statements.push(stmt(env,`INSERT INTO import_items(id,job_id,ordinal,locator,origin,object_key,mime,size,selected) VALUES(?,?,?,?,'source',?,?,?,1)`,id(),jobId,n+1,`写真 ${n+1}`,objectKey,mime,upload.bytes.length));
 }
 statements.unshift(stmt(env,`INSERT INTO import_jobs(id,request_key,request_hash,format,name,object_key,mime,size,available_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,jobId,key,hash,format,first.name,isPhotos?null:keys[0],isPhotos?null:format==='pdf'?'application/pdf':format==='epub'?'application/epub+zip':format==='json'?'application/json':'text/plain',total,now(),now()));
 for(const objectKey of keys)statements.push(stmt(env,'DELETE FROM staged_uploads WHERE object_key=?',objectKey));
 try{await env.DB.batch(statements);}catch(e){const duplicate=await stmt(env,'SELECT id FROM import_jobs WHERE request_hash=?',hash).first<{id:string}>();if(duplicate)return {id:duplicate.id,duplicate:true};throw e;}
 if(!automaticAI(env))await stmt(env,"UPDATE import_jobs SET state='ready',error_code='extraction_required' WHERE id=?",jobId).run();
 return {id:jobId,duplicate:false};
}
export async function readImport(env:Env,jobId:string){
 const job=await stmt(env,'SELECT * FROM import_jobs WHERE id=?',jobId).first<ImportJob>();if(!job)return null;
 const items=await rows<Item&{capture_state:string|null}>(env,`SELECT i.*,j.state AS capture_state FROM import_items i LEFT JOIN captures c ON c.id=i.capture_id LEFT JOIN jobs j ON j.capture_id=c.id AND j.version=c.version WHERE i.job_id=? ORDER BY COALESCE(i.display_order,i.ordinal)`,jobId);
 const {sections,...metadata}=JSON.parse(job.metadata_json);
 return {...job,metadata,metadata_json:undefined,object_key:undefined,request_key:undefined,request_hash:undefined,lease_token:undefined,items:items.map(({body,object_key,...item})=>({...item,preview:body.slice(0,300)}))};
}
async function createItemCapture(env:Env,job:ImportJob,item:Item){
 if(item.state==='deleted'||item.capture_id)return;
 const meta=JSON.parse(job.metadata_json) as ParsedDocument;
 let asset:Input['asset']=null;if(item.object_key){const obj=await env.ORIGINALS.get(item.object_key);if(!obj)throw Error('original_missing');asset={bytes:new Uint8Array(await obj.arrayBuffer()),mime:item.mime!,name:`photo-${item.ordinal}.${item.mime?.includes('png')?'png':item.mime?.includes('webp')?'webp':'jpg'}`};}
 if(!asset&&!item.body.trim())throw Error('text_unavailable');
 const input={text:item.body,note:item.note,asset,hash:await digest(JSON.stringify({body:item.body,note:item.note,origin:item.origin,locator:item.locator,title:meta.title||null,asset:asset?await digest(asset.bytes):null}))};
 const saved=await storeCapture(env,`import-item-${item.id}`,input,{title:meta.title||undefined,locator:item.locator,origin:item.origin,locked:Boolean(meta.title),guard:{sql:"EXISTS(SELECT 1 FROM import_items i JOIN import_jobs j ON j.id=i.job_id WHERE i.id=? AND i.state<>'deleted' AND j.state='running')",values:[item.id]},onSaved:captureId=>stmt(env,"UPDATE import_items SET capture_id=?,state='saved',error_code=NULL WHERE id=? AND EXISTS(SELECT 1 FROM captures WHERE id=?)",captureId,item.id,captureId)});
 await stmt(env,"UPDATE import_items SET capture_id=?,state='saved',error_code=NULL WHERE id=? AND state<>'deleted'",saved.id,item.id).run();
}
export async function selectImport(env:Env,jobId:string,ordinals:number[]){
 const job=await stmt(env,'SELECT * FROM import_jobs WHERE id=?',jobId).first<ImportJob>();if(!job)fail(404,'取り込みがありません。');if(!['ready','completed','partial'].includes(job.state)||ordinals.length<1||ordinals.length>20||new Set(ordinals).size!==ordinals.length)fail(400,'取り込む範囲を1〜20件選んでください。');
 const all=await rows<Item>(env,'SELECT * FROM import_items WHERE job_id=?',jobId);
 if(ordinals.some(n=>!all.some(x=>x.ordinal===n&&x.state!=='deleted'&&(x.body.trim()||x.object_key))))fail(400,'本文を取得できる範囲を選んでください。');
 await env.DB.batch([...ordinals.map(n=>stmt(env,"UPDATE import_items SET selected=1,state=CASE WHEN capture_id IS NULL THEN 'available' ELSE state END,error_code=NULL WHERE job_id=? AND ordinal=? AND state<>'deleted'",jobId,n)),stmt(env,"UPDATE import_jobs SET state='pending',attempts=0,error_code=NULL,available_at=?,dispatched_at=NULL WHERE id=? AND state<>'running'",now(),jobId)]);
}
export async function startImportExtraction(env:Env,jobId:string){
 const job=await stmt(env,'SELECT id FROM import_jobs WHERE id=?',jobId).first();if(!job)fail(404,'import_missing');
 await env.DB.batch([stmt(env,`INSERT INTO explicit_ai_actions VALUES('extract_import',?,1,?) ON CONFLICT(kind,target_id) DO UPDATE SET created_at=excluded.created_at`,jobId,now()),stmt(env,"UPDATE import_jobs SET state='pending',attempts=0,error_code=NULL,available_at=?,dispatched_at=NULL WHERE id=? AND state IN('ready','failed','partial')",now(),jobId)]);
 return {id:jobId,state:'pending'};
}
export async function processImport(env:Env,jobId:string){
 const token=id(),job=await stmt(env,"UPDATE import_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND state='pending' AND available_at<=? RETURNING *",token,now()+300000,jobId,now()).first<ImportJob>();if(!job)return;
 try{
  if(!automaticAI(env)&&!await stmt(env,"SELECT 1 FROM explicit_ai_actions WHERE kind='extract_import' AND target_id=?",job.id).first())throw Error('extraction_required');
  const existing=await stmt(env,'SELECT id FROM import_items WHERE job_id=? LIMIT 1',job.id).first();
  if(!existing){const object=await env.ORIGINALS.get(job.object_key!);if(!object)throw Error('original_missing');const parsed=await parseDocument(job.format,new Uint8Array(await object.arrayBuffer()));
   if(!automaticAI(env)&&job.format==='pdf'&&parsed.sections.length<=20&&parsed.sections.reduce((n,s)=>n+s.body.length,0)<=18000){const readable=parsed.sections.filter(s=>s.body.trim());if(readable.length)parsed.sections=[{body:readable.map(s=>`[${s.locator}]\n${s.body}`).join('\n\n'),locator:readable.map(s=>s.locator).join(', '),origin:'source',note:''},...parsed.sections.filter(s=>!s.body.trim())];}
   const metadata=JSON.stringify({title:parsed.title,warnings:parsed.warnings,metadata:parsed.metadata});
   await env.DB.batch([stmt(env,'UPDATE import_jobs SET metadata_json=? WHERE id=? AND lease_token=?',metadata,job.id,token),...parsed.sections.map((s,n)=>stmt(env,`INSERT OR IGNORE INTO import_items(id,job_id,ordinal,locator,origin,body,note,selected) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM import_jobs WHERE id=? AND lease_token=?)`,id(),job.id,n+1,s.locator,s.origin,s.body,s.note,['json','clippings'].includes(job.format)?1:0,job.id,token))]);
   job.metadata_json=metadata;
   if(!automaticAI(env)&&job.format==='pdf'&&parsed.sections.length<=20)await stmt(env,"UPDATE import_items SET selected=1 WHERE job_id=? AND body<>''",job.id).run();
  }
  const selected=await rows<Item>(env,"SELECT * FROM import_items WHERE job_id=? AND selected=1 AND capture_id IS NULL AND state<>'deleted' ORDER BY ordinal LIMIT 20",job.id);let failed=0;
  for(const item of selected){try{await createItemCapture(env,job,item);const saved=await stmt(env,'SELECT capture_id FROM import_items WHERE id=?',item.id).first<{capture_id:string}>();if(saved?.capture_id){const c=await stmt(env,'SELECT version FROM captures WHERE id=?',saved.capture_id).first<{version:number}>();if(c)await startExtraction(env,{waitUntil:()=>{}} as unknown as ExecutionContext,saved.capture_id,c.version);}}catch(e){failed++;await stmt(env,"UPDATE import_items SET state='failed',error_code=? WHERE id=?",e instanceof Error?e.message:'item_failed',item.id).run();}}
  const more=await stmt(env,"SELECT count(*) AS n FROM import_items WHERE job_id=? AND selected=1 AND capture_id IS NULL AND state='available'",job.id).first<number>('n');
  await stmt(env,"UPDATE import_jobs SET state=?,lease_token=NULL,dispatched_at=NULL,error_code=?,available_at=? WHERE id=? AND lease_token=?",more?'pending':failed?'partial':job.format==='pdf'||job.format==='epub'?'ready':'completed',failed?'some_items_failed':null,now(),job.id,token).run();
 }catch(e){await stmt(env,"UPDATE import_jobs SET state='failed',error_code=?,lease_token=NULL,dispatched_at=NULL WHERE id=? AND lease_token=?",e instanceof Error?e.message:'import_failed',job.id,token).run();}
}
export async function dispatchImports(env:Env){
 await stmt(env,"UPDATE import_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,lease_token=NULL,dispatched_at=NULL,error_code='worker_interrupted' WHERE state='running' AND lease_until<?",now()).run();
 for(const j of await rows<{id:string}>(env,"SELECT id FROM import_jobs WHERE state='pending' AND available_at<=? AND (dispatched_at IS NULL OR dispatched_at<?) LIMIT 5",now(),now()-300000)){
  const claimed=await stmt(env,"UPDATE import_jobs SET dispatched_at=? WHERE id=? AND state='pending' AND (dispatched_at IS NULL OR dispatched_at<?) RETURNING id",now(),j.id,now()-300000).first();if(!claimed)continue;
  try{await env.HARVEST_QUEUE.send({import_job_id:j.id},{contentType:'json'});}catch{await stmt(env,"UPDATE import_jobs SET dispatched_at=NULL WHERE id=? AND state='pending'",j.id).run();}
 }
}
export async function deleteImportArchive(env:Env,jobId:string){
 await env.DB.batch([
  stmt(env,`INSERT OR IGNORE INTO object_deletions(object_key,created_at) SELECT object_key,? FROM import_jobs WHERE id=? AND object_key IS NOT NULL UNION SELECT object_key,? FROM import_items WHERE job_id=? AND object_key IS NOT NULL`,now(),jobId,now(),jobId),
  stmt(env,'DELETE FROM import_jobs WHERE id=?',jobId),
 ]);
}
export async function importOriginal(env:Env,jobId:string,ordinal:number|null){
 const a=ordinal===null?await stmt(env,'SELECT object_key,mime,name FROM import_jobs WHERE id=?',jobId).first<{object_key:string;mime:string;name:string}>():await stmt(env,'SELECT object_key,mime FROM import_items WHERE job_id=? AND ordinal=?',jobId,ordinal).first<{object_key:string;mime:string;name?:string}>();if(!a?.object_key)return null;
 const object=await env.ORIGINALS.get(a.object_key);return object?new Response(object.body,{headers:{'Content-Type':a.mime,'Content-Disposition':'attachment; filename="original"','Content-Length':String(object.size)}}):null;
}

export async function reorderImport(env:Env,jobId:string,ordinals:number[]){
 const items=await rows<{ordinal:number}>(env,'SELECT ordinal FROM import_items WHERE job_id=?',jobId);
 if(ordinals.length!==items.length||new Set(ordinals).size!==items.length||ordinals.some(n=>!items.some(i=>i.ordinal===n)))fail(400,'すべての写真番号を一度ずつ指定してください。');
 await env.DB.batch(ordinals.map((n,index)=>stmt(env,'UPDATE import_items SET display_order=? WHERE job_id=? AND ordinal=?',index+1,jobId,n)));
}
