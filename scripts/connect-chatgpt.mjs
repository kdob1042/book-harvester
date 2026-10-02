// Run on the owner's computer. Tokens never enter browser storage, URLs, logs or git.
import {createServer} from 'node:http';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,chmod,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {pathToFileURL} from 'node:url';
const resource='https://api.openai.com/v1';
const authOrigin='https://auth.openai.com';
export function authorizationUrl(registration,attempt){
 const url=new URL('/api/accounts/authorize',authOrigin);url.search=new URLSearchParams({response_type:'code',client_id:registration.client_id||'dynamic_agent_client',redirect_uri:attempt.redirect_uri,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource,ext_agent_host_id:registration.local_host_id,state:attempt.state,nonce:attempt.nonce,code_challenge:attempt.challenge,code_challenge_method:'S256',...(!registration.client_id?{agent_name_hint:'Book Harvester'}:{})});return url;
}
export function callbackCode(url,attempt,registration){
 if(url.searchParams.get('state')!==attempt.state)throw Error('OAuth state が一致しません。');
 if(url.searchParams.has('error'))throw Error('ChatGPT の認可が完了しませんでした。');
 const issued=url.searchParams.get('issuedclient_id')||url.searchParams.get('client_id')||registration.client_id;
 if(!issued?.startsWith('oaiapp_')||registration.client_id&&issued!==registration.client_id)throw Error('OAuth client ID が一致しません。');
 const code=url.searchParams.get('code');if(!code)throw Error('OAuth code がありません。');return {code,client_id:issued};
}
async function command(args,input){return new Promise((resolve,reject)=>{const child=spawn('npx',['wrangler',...args],{cwd:new URL('..',import.meta.url),stdio:[input?'pipe':'inherit','inherit','inherit'],shell:false});child.on('error',reject);if(input){child.stdin.on('error',()=>{});child.stdin.end(input);}child.on('exit',code=>code===0?resolve():reject(Error('Cloudflare への反映に失敗しました。')));});}
async function main(){
 const directory=join(homedir(),'.config','book-harvester');await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
 const registrationPath=join(directory,'registration.json'),pendingPath=join(directory,'pending-session.json');
 let registration;try{registration=JSON.parse(await readFile(registrationPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;registration={local_host_id:`urn:uuid:${randomUUID()}`,worker_host_id:`urn:uuid:${randomUUID()}`};}
 const saveRegistration=async()=>{await writeFile(registrationPath,JSON.stringify(registration),{mode:0o600});await chmod(registrationPath,0o600);};await saveRegistration();
 let session;
 if(process.argv.includes('--retry-upload'))session=JSON.parse(await readFile(pendingPath,'utf8'));
 else {
  await command(['whoami']);
  const verifier=randomBytes(32).toString('base64url'),attempt={state:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),challenge:createHash('sha256').update(verifier).digest('base64url'),redirect_uri:'http://127.0.0.1:1455/auth/callback'};
  let fulfill,reject;const callback=new Promise((ok,no)=>{fulfill=ok;reject=no;});
  const server=createServer((request,response)=>{const url=new URL(request.url,attempt.redirect_uri);if(url.pathname!=='/auth/callback'){response.writeHead(404).end();return;}
   try{const result=callbackCode(url,attempt,registration);response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end('認可を受け取りました。この画面を閉じ、ターミナルを確認してください。');fulfill(result);}catch(error){response.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}).end('認可を確認できませんでした。');reject(error);}
  });
  await new Promise((ok,no)=>{server.once('error',no);server.listen(1455,'127.0.0.1',ok);});
  const timer=setTimeout(()=>reject(Error('認可がタイムアウトしました。再実行してください。')),10*60*1000);
  let result;
  try{const url=authorizationUrl(registration,attempt).href;const program=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open';const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];const browser=spawn(program,args,{stdio:'ignore',shell:false});browser.on('error',()=>reject(Error('ブラウザを開けませんでした。既定のブラウザを設定してください。')));console.log('ブラウザで ChatGPT にログインし、Book Harvester のサブスク枠利用を許可してください。');result=await callback;}finally{clearTimeout(timer);await new Promise(ok=>server.close(ok));}
  const response=await fetch(`${authOrigin}/api/accounts/oauth/token`,{method:'POST',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:result.client_id,code:result.code,code_verifier:verifier,redirect_uri:attempt.redirect_uri,resource})});
  if(!response.ok)throw Error('OAuth token の交換に失敗しました。');const tokens=await response.json();
  if(!tokens.access_token||!tokens.refresh_token||!tokens.id_token||!Number.isFinite(tokens.expires_in)||!['resource.invoke','chatgpt.tokens.use.direct'].every(scope=>tokens.scope?.split(' ').includes(scope)))throw Error('サブスク枠を利用する権限が付与されませんでした。');
  const discoveryResponse=await fetch(`${authOrigin}/.well-known/openid-configuration`,{signal:AbortSignal.timeout(30000)});if(!discoveryResponse.ok)throw Error('OIDC 設定を取得できませんでした。');const discovery=await discoveryResponse.json();
  if(new URL(discovery.jwks_uri).origin!==authOrigin||new URL(discovery.revocation_endpoint).origin!==authOrigin)throw Error('OIDC 設定が不正です。');
  const {payload}=await jwtVerify(tokens.id_token,createRemoteJWKSet(new URL(discovery.jwks_uri)),{issuer:discovery.issuer,audience:result.client_id});
  if(payload.nonce!==attempt.nonce||!payload.sub||typeof payload.exp!=='number'||registration.subject&&registration.subject!==payload.sub||registration.issuer&&registration.issuer!==payload.iss)throw Error('ChatGPT の本人認証を確認できませんでした。');
  registration={...registration,client_id:result.client_id,subject:payload.sub,issuer:payload.iss};await saveRegistration();
  const modelsResponse=await fetch(`${resource}/models`,{headers:{Authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(30000)});if(!modelsResponse.ok)throw Error('サブスクで使えるモデルを取得できませんでした。');const catalog=await modelsResponse.json(),available=(catalog.models||[]).filter(model=>model.visibility==='list');
  const requested=process.env.CHATGPT_MODEL,chosen=requested?available.find(model=>model.slug===requested):available[0];if(!chosen?.slug)throw Error('指定したモデルをサブスク枠で利用できません。');
  session={id:randomUUID(),key:randomBytes(32).toString('base64url'),client_id:result.client_id,host_id:registration.worker_host_id,subject:payload.sub,email:typeof payload.email==='string'?payload.email:'',access_token:tokens.access_token,refresh_token:tokens.refresh_token,expires_at:Date.now()+tokens.expires_in*1000,model:chosen.slug,scope:tokens.scope,revocation_endpoint:discovery.revocation_endpoint};
  await writeFile(pendingPath,JSON.stringify(session),{mode:0o600});await chmod(pendingPath,0o600);
 }
 // Secure Cloudflare secret transfer. Never place tokens in a command argument.
 await command(['secret','put','CHATGPT_SESSION','--env','production'],JSON.stringify(session));
 const retrySQL="UPDATE jobs SET state='pending',attempts=0,error_code=NULL,dispatched_at=NULL,available_at=0 WHERE state='blocked' AND error_code IN ('ai_not_configured','subscription_reauth_required'); UPDATE graph_jobs SET state='pending',attempts=0,error_code=NULL,dispatched_at=NULL,available_at=0 WHERE state='blocked' AND error_code IN ('ai_not_configured','subscription_reauth_required'); UPDATE reflection_jobs SET state='pending',attempts=0,error_code=NULL,dispatched_at=NULL,available_at=0 WHERE state='blocked' AND error_code IN ('ai_not_configured','subscription_reauth_required'); UPDATE research_runs SET state='pending',ai_calls=0,error_code=NULL,dispatched_at=NULL,available_at=0 WHERE state='blocked' AND error_code IN ('ai_not_configured','subscription_reauth_required');";
 // Tokens now belong to the Worker, which performs all subsequent rotating refreshes.
 await unlink(pendingPath);await command(['d1','execute','DB','--remote','--env','production','--command',retrySQL]);
 console.log(`ChatGPT 接続を反映しました（${session.model}）。アプリで文章を1件保存して動作を確認してください。`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);console.error('アップロード前の認証情報が保存されている場合は npm run connect:chatgpt -- --retry-upload で再試行できます。');process.exitCode=1;});
