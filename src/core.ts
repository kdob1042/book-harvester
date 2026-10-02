export type Evidence = { origin: 'source'|'user'|'ai'; quote: string|null; locator: string|null; certainty: 'explicit'|'inferred'|'uncertain' };
export type Harvest = {
 contract_version: number;
 classification?: {domain_ids:string[];lens_ids:string[]};
 source: { title: string|null; page: string|null; chapter: string|null; published_at:string|null; subject_period:string|null; certainty: string };
 extracted_text: string; summary: string; uncertainties: string[];
 claims: { id:string; text:string; conditions:string[]; evidence:Evidence }[];
 concepts: { id:string; name:string; description:string; claim_ids:string[] }[];
 questions: { id:string; text:string; claim_ids:string[] }[];
 view_draft: { text:string; reason:string; claim_ids:string[] }|null;
};
export type Capture = {
 id:string; version:number; kind:string; original_text:string; corrected_text:string|null; note:string;
 source_id:string|null; source_title:string|null; source_certainty:string|null; source_published_at:string|null; source_subject_period:string|null; source_inherited:number; source_locked:number;
 page:string|null; chapter:string|null; locator_certainty:string; created_at:number; updated_at:number;
 import_origin?:string|null;source_locator?:string|null;source_bibliography?:string|null;
};
export type Asset = { id:string; capture_id:string; object_key:string; name:string; mime:string; size:number; created_at:number };
export type Job = { id:string; capture_id:string; version:number; state:string; attempts:number; available_at:number; dispatched_at:number|null; lease_token:string|null; transcript:string|null; error_code:string|null };
export type View = { id:string; capture_id:string; draft_key:string; title:string; body:string; version:number; created_at:number };
export type QueueBody = { job_id:string };
export const now = () => Date.now();
export const id = () => crypto.randomUUID();
export class HttpError extends Error {
 status:number;
 constructor(status:number, message:string) { super(message); this.status=status; }
}
export function fail(status:number, message:string):never { throw new HttpError(status,message); }
export function text(value:unknown, max=20000):string {
 if (typeof value!=='string' || value.length>max) fail(400,'入力が長すぎるか、形式が違います。');
 return value;
}
export function version(value:unknown):number {
 const n=Number(value); if (!Number.isInteger(n)||n<1) fail(400,'記録の版が不明です。'); return n;
}
export const stmt = (env:Env, sql:string, ...values:(string|number|null)[]) => env.DB.prepare(sql).bind(...values);
export async function rows<T>(env:Env, sql:string, ...values:(string|number|null)[]):Promise<T[]> {
 return (await stmt(env,sql,...values).all<T>()).results;
}
export async function getCapture(env:Env, captureId:string) {
 const capture=await stmt(env,`SELECT c.*,s.title AS source_title,s.certainty AS source_certainty,s.published_at AS source_published_at,s.subject_period AS source_subject_period,s.bibliography_json AS source_bibliography FROM captures c LEFT JOIN sources s ON s.id=c.source_id WHERE c.id=?`,captureId).first<Capture>();
 if (!capture) return null;
 const [job,h,assets,views]=await Promise.all([
  stmt(env,'SELECT * FROM jobs WHERE capture_id=? AND version=?',captureId,capture.version).first<Job>(),
  stmt(env,'SELECT result FROM harvests WHERE capture_id=? AND version=?',captureId,capture.version).first<{result:string}>(),
  rows<Asset>(env,'SELECT * FROM assets WHERE capture_id=? ORDER BY created_at',captureId),
  rows<View>(env,'SELECT * FROM views WHERE capture_id=? ORDER BY created_at',captureId),
 ]);
 return {...capture,job,harvest:h?JSON.parse(h.result) as Harvest:null,assets,views};
}
export const jobStatement = (env:Env,captureId:string,revision:number,mutation:string) => stmt(env,`INSERT INTO jobs(id,capture_id,version,available_at,created_at,state,error_code)
 SELECT ?,id,version,?,?,'blocked','extraction_required' FROM captures WHERE id=? AND version=? AND mutation_id=?`,id(),now(),now(),captureId,revision,mutation);
export const revisionStatement = (env:Env,captureId:string,mutation:string) => stmt(env,`INSERT INTO capture_revisions(capture_id,version,corrected_text,note,source_id,page,created_at)
 SELECT id,version,corrected_text,note,source_id,page,? FROM captures WHERE id=? AND mutation_id=?`,now(),captureId,mutation);

export async function digest(value:string|Uint8Array):Promise<string> {
 const data=typeof value==='string'?new TextEncoder().encode(value):value;
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(n=>n.toString(16).padStart(2,'0')).join('');
}

export async function boundedBody(request:Request, max:number):Promise<Uint8Array> {
 if (Number(request.headers.get('content-length'))>max) fail(413,'ファイルは10MB以下にしてください。');
 if (!request.body) return new Uint8Array();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[]; let size=0;
 while (true) {
  const {done,value}=await reader.read(); if (done) break;
  size+=value.byteLength; if (size>max) { await reader.cancel(); fail(413,'ファイルは10MB以下にしてください。'); }
  chunks.push(value);
 }
 const bytes=new Uint8Array(size); let offset=0;
 for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;} return bytes;
}
export async function jsonBody(request:Request):Promise<Record<string,unknown>> {
 try {
  const v:unknown=JSON.parse(new TextDecoder().decode(await boundedBody(request,80000)));
  if (!v||typeof v!=='object'||Array.isArray(v)) fail(400,'入力形式を確認してください。');
  return v as Record<string,unknown>;
 } catch(e) { if(e instanceof HttpError) throw e; fail(400,'入力を読み取れませんでした。'); }
}
