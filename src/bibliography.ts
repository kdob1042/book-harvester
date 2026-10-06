import {cancellationCleanup} from './ai-cancellation.ts';
import {automaticAI} from './ai-policy.ts';
import {stmt,rows,id,now,getCapture} from './core.ts';
export function isbnFrom(text:string){
 for(const match of text.matchAll(/(?:ISBN(?:-1[03])?\s*[:：]?\s*)?((?:97[89][- ]?)?\d[\d -]{8,20}[\dXx])/g)){
  const s=match[1].replace(/[- ]/g,'').toUpperCase();
  if(s.length===13&&[...s].reduce((n,c,i)=>n+Number(c)*(i%2?3:1),0)%10===0)return s;
  if(s.length===10&&[...s].reduce((n,c,i)=>n+(c==='X'?10:Number(c))*(10-i),0)%11===0)return s;
 }return null;
}
type Candidate={title:string;authors:string[];first_publish_year:number|null;edition:string|null;url:string;isbn:string|null;match:'isbn'|'title_candidate'};
export async function lookupBibliography(text:string,title:string|null,fetcher:typeof fetch=fetch){
 const isbn=isbnFrom(text);if(!isbn&&!title)return [];
 const url=new URL('https://openlibrary.org/search.json');if(isbn)url.searchParams.set('isbn',isbn);else url.searchParams.set('title',title!.slice(0,500));url.searchParams.set('limit','3');url.searchParams.set('fields','key,title,author_name,first_publish_year,edition_key');
 const response=await fetcher(url.toString(),{headers:{'User-Agent':'BookHarvester/0.1 (https://github.com/kdob1042/book-harvester)'},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok){await response.body?.cancel();throw Error('bibliography_unavailable');}
 const {boundedBody}=await import('./core.ts');const data=JSON.parse(new TextDecoder().decode(await boundedBody(new Request('http://localhost',{method:'POST',body:response.body,duplex:'half'} as RequestInit),100000))) as {docs?:Record<string,unknown>[]};
 return (data.docs||[]).slice(0,3).flatMap(d=>{if(typeof d.title!=='string'||typeof d.key!=='string'||!/^\/works\/OL\d+W$/.test(d.key))return [];return [{title:d.title.slice(0,500),authors:Array.isArray(d.author_name)?d.author_name.filter(x=>typeof x==='string').slice(0,10):[],first_publish_year:typeof d.first_publish_year==='number'?d.first_publish_year:null,edition:Array.isArray(d.edition_key)&&typeof d.edition_key[0]==='string'?d.edition_key[0]:null,url:`https://openlibrary.org${d.key}`,isbn,match:isbn?'isbn':'title_candidate'} satisfies Candidate];});
}
export async function scheduleBibliography(env:Env,captureId:string,v:number){if(!automaticAI(env))return;
 await stmt(env,`INSERT INTO bibliography_jobs(capture_id,version,available_at) VALUES(?,?,?) ON CONFLICT(capture_id) DO UPDATE SET version=excluded.version,state='pending',attempts=0,error_code=NULL,available_at=excluded.available_at,dispatched_at=NULL,lease_token=NULL WHERE version<>excluded.version`,captureId,v,now()).run();
}
export async function processBibliography(env:Env,captureId:string,fetcher:typeof fetch=fetch){if(!automaticAI(env))return;
 const token=id(),j=await stmt(env,"UPDATE bibliography_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE capture_id=? AND state='pending' AND available_at<=? RETURNING version",token,now()+30000,captureId,now()).first<{version:number}>();if(!j)return;
 try{
  const c=await getCapture(env,captureId);if(!c?.harvest||c.version!==j.version){await stmt(env,"UPDATE bibliography_jobs SET state='superseded',lease_token=NULL WHERE capture_id=? AND lease_token=?",captureId,token).run();return;}
  const isbn=isbnFrom(c.harvest.extracted_text),query=isbn||c.source_title;if(!query){await stmt(env,"UPDATE bibliography_jobs SET state='completed',lease_token=NULL WHERE capture_id=? AND lease_token=?",captureId,token).run();return;}
  const cache=await stmt(env,'SELECT result_json FROM bibliography_cache WHERE query=? AND created_at>?',query,now()-7*86400000).first<{result_json:string}>();
  const candidates=cache?JSON.parse(cache.result_json):await lookupBibliography(c.harvest.extracted_text,c.source_title,fetcher);
  if(!cache)await stmt(env,'INSERT OR REPLACE INTO bibliography_cache VALUES(?,?,?)',query,JSON.stringify(candidates),now()).run();
  const metadata=JSON.stringify({provider:'Open Library',fetched_at:new Date().toISOString(),query,candidates,certainty:candidates.length===1&&isbn?'identifier_match':'possible',edition_verified:false});
  await env.DB.batch([stmt(env,`UPDATE sources SET bibliography_json=? WHERE id=? AND EXISTS(SELECT 1 FROM captures WHERE id=? AND version=? AND source_id=sources.id) AND EXISTS(SELECT 1 FROM bibliography_jobs WHERE capture_id=? AND lease_token=?)`,metadata,c.source_id,captureId,j.version,captureId,token),stmt(env,"UPDATE bibliography_jobs SET state='completed',lease_token=NULL,error_code=NULL WHERE capture_id=? AND lease_token=?",captureId,token)]);
 }catch{await stmt(env,"UPDATE bibliography_jobs SET state=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,error_code='bibliography_unavailable',lease_token=NULL,dispatched_at=NULL,available_at=? WHERE capture_id=? AND lease_token=?",now()+60000,captureId,token).run();}
}
export async function dispatchBibliography(env:Env){
 env=cancellationCleanup(env);if(!automaticAI(env))return;
 await stmt(env,"UPDATE bibliography_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error_code='worker_interrupted',dispatched_at=NULL,lease_token=NULL WHERE state='running' AND lease_until<?",now()).run();
 // One dispatched request per minute; cached queries do not hit the public API.
 const j=await stmt(env,"UPDATE bibliography_jobs SET dispatched_at=? WHERE capture_id=(SELECT capture_id FROM bibliography_jobs WHERE state='pending' AND available_at<=? AND (dispatched_at IS NULL OR dispatched_at<?) ORDER BY available_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM settings WHERE key='bibliography_last_dispatch' AND CAST(value AS INTEGER)>?) RETURNING capture_id",now(),now(),now()-300000,now()-60000).first<{capture_id:string}>();if(!j)return;
 await stmt(env,"INSERT OR REPLACE INTO settings VALUES('bibliography_last_dispatch',?)",String(now())).run();
 try{await env.HARVEST_QUEUE.send({bibliography_capture_id:j.capture_id},{contentType:'json'});}catch{await stmt(env,"UPDATE bibliography_jobs SET dispatched_at=NULL WHERE capture_id=? AND state='pending'",j.capture_id).run();}
}
