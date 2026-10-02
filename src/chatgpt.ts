import {Buffer} from 'node:buffer';
import {stmt,id,now} from './core.ts';
export class SubscriptionError extends Error {
 code:string;retryable:boolean;
 constructor(code:string,retryable=false){super(code);this.code=code;this.retryable=retryable;}
}
export type Session={id:string;key:string;client_id:string;host_id:string;subject:string;email:string;access_token:string;refresh_token:string;expires_at:number;model:string;scope:string;revocation_endpoint:string};
export const subscriptionMode=(env:Env)=>env.AI_AUTH_MODE==='chatgpt';
export const aiConfigured=(env:Env)=>Boolean(subscriptionMode(env)?env.CHATGPT_SESSION:env.OPENAI_API_KEY);
export const keyMode=(env:Env)=>!subscriptionMode(env)&&Boolean(env.OPENAI_API_KEY);
function seed(env:Env):Session {
 try {const s=JSON.parse(env.CHATGPT_SESSION||'');if(!s.id||!s.client_id?.startsWith('oaiapp_')||!s.access_token||!s.refresh_token||!s.model||!s.scope?.split(' ').includes('chatgpt.tokens.use.direct')||Buffer.from(s.key,'base64url').length!==32)throw Error();return s;}
 catch {throw new SubscriptionError('ai_not_configured');}
}
async function key(s:Session){return crypto.subtle.importKey('raw',Buffer.from(s.key,'base64url'),'AES-GCM',false,['encrypt','decrypt']);}
export async function encryptSession(s:Session,value:Session){const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(s.id)},await key(s),new TextEncoder().encode(JSON.stringify(value)));return Buffer.concat([iv,Buffer.from(cipher)]).toString('base64url');}
async function decrypt(s:Session,value:string):Promise<Session>{const bytes=Buffer.from(value,'base64url');return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:new TextEncoder().encode(s.id)},await key(s),bytes.subarray(12))));}
async function stored(env:Env,s:Session){await stmt(env,'INSERT OR IGNORE INTO chatgpt_sessions(id,encrypted) VALUES(?,?)',s.id,await encryptSession(s,s)).run();return (await stmt(env,'SELECT * FROM chatgpt_sessions WHERE id=?',s.id).first<{encrypted:string;state:string}>())!;}
export async function chatgptStatus(env:Env){
 if(!subscriptionMode(env))return {mode:'api_key',state:aiConfigured(env)?'configured':'not_configured'};
 if(!env.CHATGPT_SESSION)return {mode:'chatgpt',state:'not_configured'};
 try{const s=seed(env),row=await stored(env,s);return {mode:'chatgpt',state:row.state,email:s.email,model:s.model};}catch{return {mode:'chatgpt',state:'not_configured'};}
}
export async function credentials(env:Env,fetcher:typeof fetch=fetch):Promise<Session>{
 const s=seed(env),row=await stored(env,s);if(row.state!=='connected')throw new SubscriptionError('subscription_reauth_required');
 const current=await decrypt(s,row.encrypted);if(current.expires_at>now()+120000)return current;
 const token=id(),lock=await stmt(env,"UPDATE chatgpt_sessions SET lease_token=?,lease_until=? WHERE id=? AND state='connected' AND lease_until<? RETURNING id",token,now()+45000,s.id,now()).first();
 if(!lock)throw new SubscriptionError('subscription_refresh_busy',true);
 try{
  // Reread after claiming to avoid rotating a token another isolate already replaced.
  const latest=await stmt(env,'SELECT encrypted FROM chatgpt_sessions WHERE id=?',s.id).first<string>('encrypted'),active=await decrypt(s,latest!);
  if(active.expires_at>now()+120000)return active;
  const response=await fetcher('https://auth.openai.com/api/accounts/oauth/token',{method:'POST',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:active.client_id,refresh_token:active.refresh_token,resource:'https://api.openai.com/v1'})});
  if(!response.ok){await response.body?.cancel();if(response.status===400||response.status===401){await stmt(env,"UPDATE chatgpt_sessions SET state='reauth_required' WHERE id=? AND lease_token=?",s.id,token).run();throw new SubscriptionError('subscription_reauth_required');}throw new SubscriptionError('subscription_refresh_failed',true);}
  const result=await response.json<{access_token:string;refresh_token?:string;expires_in:number;scope?:string}>();
  if(!result.access_token||!Number.isFinite(result.expires_in)||result.scope&&!result.scope.split(' ').includes('chatgpt.tokens.use.direct'))throw new SubscriptionError('subscription_reauth_required');
  const updated={...active,access_token:result.access_token,refresh_token:result.refresh_token||active.refresh_token,expires_at:now()+result.expires_in*1000};
  const saved=await stmt(env,"UPDATE chatgpt_sessions SET encrypted=? WHERE id=? AND lease_token=? AND state='connected' RETURNING id",await encryptSession(s,updated),s.id,token).first();if(!saved)throw new SubscriptionError('subscription_reauth_required');return updated;
 }finally{await stmt(env,'UPDATE chatgpt_sessions SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?',s.id,token).run();}
}
export async function disconnectChatgpt(env:Env,fetcher:typeof fetch=fetch){
 const s=seed(env),row=await stored(env,s);if(row.state==='disconnected')return;
 // Claim the same lease as refresh; never revoke an already rotated refresh token.
 const token=id(),lock=await stmt(env,'UPDATE chatgpt_sessions SET lease_token=?,lease_until=? WHERE id=? AND lease_until<? RETURNING id',token,now()+45000,s.id,now()).first();if(!lock)throw new SubscriptionError('subscription_refresh_busy',true);
 try{const value=await stmt(env,'SELECT encrypted FROM chatgpt_sessions WHERE id=?',s.id).first<string>('encrypted'),active=await decrypt(s,value!);
  const endpoint=new URL(active.revocation_endpoint);if(endpoint.origin!=='https://auth.openai.com')throw new SubscriptionError('subscription_reauth_required');
  const response=await fetcher(endpoint,{method:'POST',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:active.refresh_token,token_type_hint:'refresh_token',client_id:active.client_id})});
  if(!response.ok){await response.body?.cancel();throw new SubscriptionError('subscription_revoke_failed',true);}await response.body?.cancel();
  await stmt(env,"UPDATE chatgpt_sessions SET state='disconnected',encrypted='' WHERE id=? AND lease_token=?",s.id,token).run();
 }finally{await stmt(env,'UPDATE chatgpt_sessions SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?',s.id,token).run();}
}
export function subscriptionPayload(payload:Record<string,unknown>,model:string){
 const banned=new Set('background conversation max_output_tokens max_tool_calls metadata moderation multi_agent prompt prompt_cache_retention safety_identifier temperature top_logprobs top_p truncation user previous_response_id'.split(' '));
 const result=Object.fromEntries(Object.entries(payload).filter(([k])=>!banned.has(k)));return {...result,model,store:false,stream:true,input:typeof payload.input==='string'?[{role:'user',content:[{type:'input_text',text:payload.input}]}]:payload.input};
}
function streamError(event:any){const code=event.error?.code||event.response?.error?.code||event.code;return new SubscriptionError(['subscription_sharing_usage_limit_exceeded','subscription_sharing_usage_unavailable'].includes(code)?code:'subscription_response_failed',code==='subscription_sharing_usage_unavailable');}
export async function completedResponse(response:Response):Promise<any>{
 if(!response.ok){let data:any;try{data=await response.json();}catch{}if(response.status===401)throw new SubscriptionError('subscription_reauth_required');if(data?.error?.code)throw streamError(data);throw new SubscriptionError(response.status===429?'subscription_sharing_usage_limit_exceeded':'subscription_provider_rejected',response.status>=500);}
 if(!response.headers.get('content-type')?.includes('text/event-stream')||!response.body)throw new SubscriptionError('subscription_invalid_stream');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8*1024*1024)throw new SubscriptionError('subscription_stream_too_large');buffer+=decoder.decode(value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');
  let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const raw=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(!raw||raw==='[DONE]')continue;let event;try{event=JSON.parse(raw);}catch{throw new SubscriptionError('subscription_invalid_stream');}
   if(['error','response.failed','response.incomplete'].includes(event.type))throw streamError(event);
   if(event.type==='response.completed'){if(event.response?.status!=='completed')throw streamError(event);return event.response;}
  }
 }throw new SubscriptionError('subscription_interrupted_stream',true);}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
