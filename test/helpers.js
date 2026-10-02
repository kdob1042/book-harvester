import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import worker from '../src/index.ts';
import {processJob} from '../src/queue.ts';

class Statement {
 constructor(db,sql,values=[]){this.db=db;this.sql=sql;this.values=values;}
 bind(...values){return new Statement(this.db,this.sql,values);}
 exec(){
  const results=this.db.prepare(this.sql).all(...this.values);
  return {success:true,results,meta:{changes:this.db.prepare('SELECT changes() AS n').get().n}};
 }
 async all(){return this.exec();}
 async first(column){const row=this.exec().results[0]||null;return column?row?.[column]??null:row;}
 async run(){return this.exec();}
}

export async function fixture({key='test-fixture-key',limit='60'}={}){
 const db=new DatabaseSync(':memory:');db.exec(await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const objects=new Map(),messages=[],pending=[];
 const env={APP_PASSWORD:'test-only-long-password',APP_ORIGIN:'http://localhost:8787',OPENAI_API_KEY:key,OPENAI_MODEL:'gpt-4.1-mini',OPENAI_TRANSCRIBE_MODEL:'gpt-4o-mini-transcribe',AI_DAILY_CALL_LIMIT:limit,AI_MAX_OUTPUT_TOKENS:'4000',
  DB:{prepare:sql=>new Statement(db,sql),async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.exec());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}},
  ORIGINALS:{async put(key,bytes){objects.set(key,new Uint8Array(bytes));},async get(key){const bytes=objects.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),arrayBuffer:async()=>bytes.slice().buffer}:null;},async delete(key){objects.delete(key);}},
  HARVEST_QUEUE:{async send(message){messages.push(message);}},
  ASSETS:{async fetch(request){const path=new URL(request.url).pathname;const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};if(!files[path])return new Response('Not found',{status:404});return new Response(await readFile(new URL(`../public/${files[path]}`,import.meta.url)),{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html'}});}},
 };
 const ctx={waitUntil(promise){pending.push(promise);}};
 let cookie='';
 async function request(path,options={}){
  const headers=new Headers(options.headers);if(cookie)headers.set('cookie',cookie);
  if(options.method&&options.method!=='GET')headers.set('origin',options.origin||env.APP_ORIGIN);
  const response=await worker.fetch(new Request(`${env.APP_ORIGIN}${path}`,{...options,headers}),env,ctx);
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;
 }
 async function login(){const response=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:env.APP_PASSWORD})});if(response.status!==200)throw new Error('Fixture login failed');}
 async function settle(){while(pending.length)await Promise.all(pending.splice(0));}
 async function drain(fetcher=mockAi){await settle();while(messages.length){await processJob(env,messages.shift().job_id,fetcher);}}
 return {env,db,objects,messages,pending,request,login,settle,drain,worker,ctx,close:()=>db.close()};
}
export const sentence='供給能力が追いつかないと価格が上昇する。';
export function result(){return {
 source:{title:'供給のしくみ',page:'83',chapter:null,published_at:null,subject_period:null,certainty:'explicit'},extracted_text:sentence,summary:'供給制約は価格に影響する。',uncertainties:[],
 claims:[{id:'c1',text:sentence,conditions:['需要が供給を上回る場合'],evidence:{origin:'source',quote:sentence,locator:'p.83',certainty:'explicit'}}],
 concepts:[{id:'k1',name:'供給制約',description:'需要に供給能力が追いつかない状況',claim_ids:['c1']}],
 questions:[{id:'q1',text:'供給制約はいつ解消するのか？',claim_ids:['c1']}],
 view_draft:{text:'価格の変化を考えるときは、需要だけでなく供給能力も見る。',reason:'本文が供給不足と価格変化を結びつけているため。',claim_ids:['c1']},
};}
export async function mockAi(url,options){
 if(url.endsWith('/audio/transcriptions'))return Response.json({text:sentence});
 return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result())}]}],usage:{input_tokens:100,output_tokens:200}});
}
export const json=(method,value)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
export function photo(name='page.png'){
 const form=new FormData();
 // A valid 1x1 PNG. All fixtures are synthetic, not user material.
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');
 form.set('file',new Blob([bytes],{type:'image/png'}),name);return form;
}
export function audio(){
 const form=new FormData(),bytes=new Uint8Array(48);bytes.set(new TextEncoder().encode('RIFF'),0);bytes.set(new TextEncoder().encode('WAVE'),8);
 form.set('file',new Blob([bytes],{type:'audio/wav'}),'note.wav');return form;
}
