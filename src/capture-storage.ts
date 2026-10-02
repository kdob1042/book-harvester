import {stmt,id,now,fail,revisionStatement,jobStatement} from './core.ts';
import {stageAsset,type Input} from './input.ts';
export type SourceContext={title?:string|null;page?:string|null;locator?:string|null;origin?:string;locked?:boolean;guard?:{sql:string;values:(string|number|null)[]};onSaved?:(captureId:string)=>D1PreparedStatement};
export async function storeCapture(env:Env,key:string,input:Input,context:SourceContext={}){
 if(await stmt(env,'SELECT capture_id FROM capture_tombstones WHERE request_key=?',key).first())fail(410,'この保存操作の記録は削除済みです。自動で復元しません。');
 const prior=await stmt(env,'SELECT id,request_hash FROM captures WHERE request_key=?',key).first<{id:string;request_hash:string}>();
 if(prior){if(prior.request_hash!==input.hash)fail(409,'同じ保存操作で異なる内容が届きました。');return {id:prior.id,duplicate:true};}
 const objectKey=await stageAsset(env,key,input),captureId=id(),mutation=id(),time=now();
 const current=context.title===undefined?await stmt(env,"SELECT value FROM settings WHERE key='current_source'").first<{value:string}>():null;
 const sourceId=id(),statements:D1PreparedStatement[]=[];
 if(context.title)statements.push(stmt(env,"INSERT OR IGNORE INTO sources(id,title,certainty,created_at) VALUES(?,?,'explicit',?)",sourceId,context.title,time));
 const source=context.title?'(SELECT id FROM sources WHERE title=?)':'?';
 statements.push(stmt(env,`INSERT INTO captures(id,request_key,request_hash,source_id,source_inherited,kind,original_text,note,mutation_id,created_at,updated_at,page,source_locator,import_origin,source_locked,locator_certainty)
 SELECT ?,?,?,${source},?,?,?,?,?,?,?,?,?,?,?,? WHERE ${context.guard?.sql||'1'}`,captureId,key,input.hash,context.title||current?.value||null,current?1:0,input.asset?input.asset.mime.startsWith('image/')?'image':'audio':'text',input.text,input.note,mutation,time,time,context.page||null,context.locator||null,context.origin||null,context.locked?1:0,context.locator?'explicit':'unknown',...context.guard?.values||[]));
 if(input.asset&&objectKey)statements.push(stmt(env,`INSERT INTO assets(id,capture_id,object_key,name,mime,size,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM captures WHERE id=?)`,id(),captureId,objectKey,input.asset.name,input.asset.mime,input.asset.bytes.length,time,captureId),stmt(env,'DELETE FROM staged_uploads WHERE object_key=? AND EXISTS(SELECT 1 FROM assets WHERE object_key=?)',objectKey,objectKey));
 statements.push(revisionStatement(env,captureId,mutation),jobStatement(env,captureId,1,mutation));
 if(context.onSaved)statements.push(context.onSaved(captureId));
 try{await env.DB.batch(statements);}catch(e){const duplicate=await stmt(env,'SELECT id,request_hash FROM captures WHERE request_key=?',key).first<{id:string;request_hash:string}>();if(duplicate?.request_hash===input.hash)return {id:duplicate.id,duplicate:true};if(duplicate)fail(409,'同じ保存操作で異なる内容が届きました。');throw e;}
 if(!await stmt(env,'SELECT id FROM captures WHERE id=?',captureId).first())fail(409,'保存対象が変更・削除されました。');return {id:captureId,duplicate:false};
}
