import {processThemeJob} from '../src/themes.ts';
// Tests may only use explicit provider doubles; never send fixture payloads off-device.
const testFetch=globalThis.fetch;let providerDouble=null;
export function setProviderDouble(fn){providerDouble=fn;}
globalThis.fetch=(url,options)=>{const u=new URL(url instanceof Request?url.url:String(url));if(u.hostname==='api.openai.com'&&providerDouble)return providerDouble(String(url),options);if(!['localhost','127.0.0.1'].includes(u.hostname))return Promise.reject(Error('unexpected_external_network_in_test'));return testFetch(url,options);};
import {processEmbedding} from '../src/semantic.ts';
import {processResearch} from '../src/research.ts';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import app from '../src/index.ts';
import {withAIOperations} from '../src/ai-operation-worker.ts';
const worker=withAIOperations(app);
import {processJob,dispatch} from '../src/queue.ts';
import {processGraphJob} from '../src/graph.ts';
import {processReflection} from '../src/reflections.ts';
import {processImport} from '../src/imports.ts';
import {processBibliography} from '../src/bibliography.ts';

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

export async function fixture({key='test-fixture-key',limit='60',policy='automatic_legacy'}={}){
 const db=new DatabaseSync(':memory:');for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort())db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
 const objects=new Map(),messages=[],pending=[];
 const env={APP_PASSWORD:'test-only-long-password',APP_ORIGIN:'http://localhost:8787',OPENAI_API_KEY:key,OPENAI_MODEL:'gpt-4.1-mini',OPENAI_TRANSCRIBE_MODEL:'gpt-4o-mini-transcribe',OPENAI_RESEARCH_MODEL:'gpt-4.1-mini',RESEARCH_ALLOWED_HOSTS:'',AI_DAILY_CALL_LIMIT:limit,AI_MAX_OUTPUT_TOKENS:'4000',AI_EXECUTION_POLICY:policy,
  DB:{prepare:sql=>new Statement(db,sql),async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.exec());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}},
  ORIGINALS:{async put(key,bytes){objects.set(key,new Uint8Array(bytes));},async get(key){const bytes=objects.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),arrayBuffer:async()=>bytes.slice().buffer}:null;},async delete(key){objects.delete(key);}},
  HARVEST_QUEUE:{async send(message){messages.push(message);}},
  ASSETS:{async fetch(request){const path=new URL(request.url).pathname;const files={'/':'index.html','/app.js':'app.js','/question-tree.js':'question-tree.js','/drilldown-panel.js':'drilldown-panel.js','/ai-activity.js':'ai-activity.js','/ai-activity.css':'ai-activity.css','/style.css':'style.css','/favicon.svg':'favicon.svg','/offline.js':'offline.js','/ai-operations.js':'ai-operations.js','/ai-retry.js':'ai-retry.js','/ai-action-contract.js':'ai-action-contract.js','/sw.js':'sw.js','/manifest.webmanifest':'manifest.webmanifest','/index.html':'index.html','/icon-192.png':'icon-192.png','/icon-512.png':'icon-512.png','/connections-entry.js':'connections-entry.js','/connections-model.js':'connections-model.js','/connections-viewer.js':'connections-viewer.js','/connections.css':'connections.css'};if(!files[path])return new Response('Not found',{status:404});return new Response(await readFile(new URL(`../public/${files[path]}`,import.meta.url)),{headers:{'Content-Type':path.endsWith('.png')?'image/png':path.endsWith('.webmanifest')?'application/manifest+json':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html'}});}},
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
 async function drain(fetcher=mockAi){await settle();while(messages.length){const message=messages.shift();if(message.job_id)await processJob(env,message.job_id,fetcher);else if(message.theme_job_id)await processThemeJob(env,message.theme_job_id,fetcher);else if(message.graph_job_id)await processGraphJob(env,message.graph_job_id,fetcher);else if(message.import_job_id)await processImport(env,message.import_job_id);else if(message.bibliography_capture_id)await processBibliography(env,message.bibliography_capture_id,async()=>Response.json({docs:[]}));else if(message.embedding_capture_id)await processEmbedding(env,message.embedding_capture_id,async()=>Response.json({data:[{embedding:Array.from({length:256},(_,i)=>i===0?1:0)}]}));else if(message.research_id)await processResearch(env,message.research_id,fetcher);else if(message.reflection_job_id)await processReflection(env,message.reflection_job_id,fetcher);else throw Error('Unknown fixture queue message');await dispatch(env);}}
 return {env,db,objects,messages,pending,request,login,settle,drain,worker,ctx,close:async()=>{await settle();db.close();}};
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
 if(JSON.parse(options.body).text?.format?.name==='theme_membership_v1')return graphResponse({}, {memberships:[],candidate:null});
 if(JSON.parse(options.body).text?.format?.name==='reading_reflection_v1'){const input=JSON.parse(JSON.parse(options.body).input);return graphResponse(input,reflectionResult(input));}
 if(JSON.parse(options.body).text?.format?.name==='knowledge_graph_v1')return graphResponse(JSON.parse(JSON.parse(options.body).input));
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

export function graphResult(input){const h=input.current.harvest;return {
 claim_context:h.claims.map(c=>({claim_id:c.id,speaker:null,subject:null,scope:c.conditions.join('、'),subject_period:null})),
 concept_resolution:h.concepts.map(k=>({concept_id:k.id,existing_id:null,decision:'new',reason:'提供された意味を独立に保存する。',aliases:[]})),
 relations:h.concepts.filter(k=>k.claim_ids.length).map((k,i)=>({id:`r${i+1}`,from_id:k.claim_ids[0],to_id:k.id,type:'about',reason:'主張を説明する概念',conditions:[],interpretation:'ai_hypothesis',evidence:[{claim_id:k.claim_ids[0],quote:h.claims.find(c=>c.id===k.claim_ids[0]).evidence.quote}]})),
 mechanisms:[],discoveries:[],view_proposal:null,
};}
export function graphResponse(input,output=graphResult(input)){return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}],usage:{input_tokens:100,output_tokens:200}});}

export function reflectionResult(input){return {summary:'保存した記録から、条件を含めて理解を持ち帰る。',takeaways:input.captures.slice(0,1).map(c=>({text:c.harvest.summary,capture_ids:[c.id]})),question_ids:input.questions.slice(0,1).map(q=>q.id),connections:input.relations.slice(0,1).map(r=>({relation_id:r.id,text:JSON.parse(r.payload).reason})),view_changes:input.view_changes.slice(0,1).map(v=>({view_id:v.id,version:v.version,text:'本人が採用・改訂した見方を履歴から確認する。'})),user_note:null};}
