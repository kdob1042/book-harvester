import {boundedBody,digest,text,fail,HttpError} from './core.ts';

export const MAX_UPLOAD=10*1024*1024;
export type Input={text:string;note:string;source?:string;asset:{bytes:Uint8Array;mime:string;name:string}|null;hash:string};
export function requestKey(request:Request) {
 const key=request.headers.get('idempotency-key');
 if(!key||!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) fail(400,'保存リクエストを確認できません。'); return key;
}
function sniff(bytes:Uint8Array):[string,string]|null {
 const ascii=(a:number,b:number)=>new TextDecoder().decode(bytes.slice(a,b));
 const match=(a:number[])=>a.every((n,i)=>bytes[i]===n);
 if(bytes.length<12) return null;
 if(match([137,80,78,71,13,10,26,10])) return ['image/png','png'];
 if(match([255,216,255])) return ['image/jpeg','jpg'];
 if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP') return ['image/webp','webp'];
 if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE') return ['audio/wav','wav'];
 if(ascii(0,4)==='OggS') return ['audio/ogg','ogg'];
 if(ascii(0,4)==='fLaC') return ['audio/flac','flac'];
 if(match([26,69,223,163])) return ['audio/webm','webm'];
 if(ascii(4,8)==='ftyp') return ['audio/mp4','m4a'];
 if(ascii(0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&0xe0)===0xe0)) return ['audio/mpeg','mp3'];
 return null;
}
export async function captureInput(request:Request):Promise<Input> {
 const bytes=await boundedBody(request,MAX_UPLOAD+65536),type=request.headers.get('content-type')||'';
 let input:Omit<Input,'hash'>;
 if(type.startsWith('application/json')) {
  try {
   const value=JSON.parse(new TextDecoder().decode(bytes));
   const original=text(value.text).trim(); if(!original) fail(400,'残したい文章を入力してください。');
   const source=text(value.source??'',2000).trim();
   if(/^[a-z][a-z0-9+.-]*:/i.test(source)&&!/^https?:\/\//i.test(source))fail(400,'出典リンクはHTTPまたはHTTPSで入力してください。');
   if(/^https?:\/\//i.test(source)){try{const url=new URL(source);if(url.username||url.password)fail(400,'認証情報を含むリンクは保存できません。');}catch(e){if(e instanceof HttpError)throw e;fail(400,'出典リンクを確認してください。');}}
   input={text:original,note:text(value.note||''),source,asset:null};
  } catch(e) {if(e instanceof HttpError)throw e;fail(400,'文章を読み取れませんでした。');}
 } else {
  if(!type.startsWith('multipart/form-data')) fail(415,'写真・音声・文章を選んでください。');
  let form:FormData;
  try {form=await new Request('http://localhost',{method:'POST',headers:{'Content-Type':type},body:bytes}).formData();}
  catch {fail(400,'ファイルを読み取れませんでした。');}
  const files=form.getAll('file'),file=files[0];
  if(files.length!==1||!(file instanceof File)) fail(400,'ファイルを一つ選んでください。');
  if(file.size>MAX_UPLOAD) fail(413,'ファイルは10MB以下にしてください。');
  const data=new Uint8Array(await file.arrayBuffer()),detected=sniff(data);
  if(!detected||file.type.startsWith('image/')!==detected[0].startsWith('image/')) fail(415,'JPEG・PNG・WebP画像、または対応した音声ファイルを選んでください。');
  input={text:'',note:text(form.get('note')||''),asset:{bytes:data,mime:detected[0],name:`original.${detected[1]}`}};
 }
 const fingerprint=await digest(`${JSON.stringify({text:input.text,note:input.note,...(input.source!==undefined?{source:input.source}:{}),mime:input.asset?.mime})}:${input.asset?await digest(input.asset.bytes):''}`);
 return {...input,hash:fingerprint};
}

export async function stageAsset(env:Env,key:string,input:Input) {
 if(!input.asset) return null;
 const objectKey=`originals/${await digest(key)}/${input.hash}/${input.asset.name}`;
 // An outbox also tracks objects put before their relational metadata is committed.
 await env.DB.prepare('INSERT OR IGNORE INTO staged_uploads VALUES(?,?)').bind(objectKey,Date.now()).run();
 await env.ORIGINALS.put(objectKey,input.asset.bytes,{httpMetadata:{contentType:input.asset.mime}});
 return objectKey;
}
