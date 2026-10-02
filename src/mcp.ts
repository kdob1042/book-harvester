import OAuthProvider,{type OAuthHelpers,AuthorizationError} from '@cloudflare/workers-oauth-provider';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {z} from 'zod';
import {accessAuthorized} from './auth.ts';
import {toolSpecs,required} from './mcp-tools.ts';
interface McpEnv extends Env {OAUTH_KV:KVNamespace;OAUTH_PROVIDER:OAuthHelpers;BOOK:{call(name:string,args:Record<string,unknown>):Promise<unknown>};MCP_ORIGIN:string}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
const apiHandler:Required<Pick<ExportedHandler<McpEnv>,'fetch'>>={async fetch(request,env,ctx){
 const auth=(ctx as unknown as {auth:{scope:string[]};props:{email:string}});
 if(auth.props?.email!==env.ACCESS_EMAIL)return new Response('Forbidden',{status:403});
 const server=new McpServer({name:'book-harvester',version:'0.1.0'});
 for(const [name,description,scope,properties] of toolSpecs){
  const shape:Record<string,z.ZodType>= {};for(const [key,spec] of Object.entries(properties)){
   const p=spec as {type:string;enum?:string[];minimum?:number;maximum?:number;items?:{type:string}};let schema:z.ZodType=p.type==='integer'?z.number().int().min(p.minimum??1).max(p.maximum??Number.MAX_SAFE_INTEGER):p.type==='array'?z.array(z.string()).max(20):p.enum?z.enum(p.enum as [string,...string[]]):z.string().max(key==='text'||key==='body'?20000:2000);
   shape[key]=(required[name]||[]).includes(key)?schema:schema.optional();
  }
  server.registerTool(name,{description,inputSchema:shape,annotations:{readOnlyHint:scope==='book:read',destructiveHint:name==='delete_capture',openWorldHint:name==='start_research',idempotentHint:name==='save_capture'}},async args=>{
   if(!auth.auth?.scope.includes(scope))return {isError:true,content:[{type:'text',text:JSON.stringify({error:{code:'insufficient_scope',required:scope}})}]};
   try {
    const a=args as Record<string,unknown>;
    if(scope!=='book:read'&&name!=='preview_delete'&&!/^[a-zA-Z0-9_-]{16,100}$/.test(String(a.idempotency_key||'')))throw new Error('invalid_idempotency_key');
    let result:unknown;
    if(name==='preview_delete'){
     const record=await env.BOOK.call('get_record',{id:a.id}) as {data:{version:number;assets:unknown[];views?:unknown[]}};
     if(record.data.version!==a.version)throw new Error('version_conflict');
     const token=crypto.randomUUID();await env.OAUTH_KV.put(`delete:${token}`,JSON.stringify({email:auth.props.email,id:a.id,version:a.version}),{expirationTtl:300});result={id:a.id,version:a.version,confirmation:token,expires_in:300,impact:'Deletes record, originals and generated evidence. Linked user views and their revisions are also deleted.',assets:record.data.assets.length};
    }else{
     if(name==='delete_capture'){
      const value=await env.OAUTH_KV.get(`delete:${a.confirmation}`);if(!value)throw new Error('confirmation_expired');const v=JSON.parse(value);if(v.email!==auth.props.email||v.id!==a.id||v.version!==a.version)throw new Error('confirmation_mismatch');
     }
     result=await env.BOOK.call(name,a);
    }
    const failed=Boolean((result as {error?:unknown;status?:number}).error)||((result as {status?:number}).status||200)>=400;
    return {isError:failed,content:[{type:'text',text:JSON.stringify(result)}]};
   }catch{return {isError:true,content:[{type:'text',text:JSON.stringify({error:{code:'operation_failed',message:'Read current version and retry. No success is implied.'}})}]};}
  });
 }
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(transport);return transport.handleRequest(request);
}};
const defaultHandler:ExportedHandler<McpEnv>={async fetch(request,env,ctx){
 const url=new URL(request.url);if(url.pathname==='/healthz')return Response.json({ok:true,service:'book-mcp'});
 if(url.pathname!=='/authorize')return new Response('Not found',{status:404});
 if(!await accessAuthorized(env,ctx,request))return new Response('Owner login required',{status:403});
 try{
  const oauth=env.OAUTH_PROVIDER;
  if(request.method==='GET'){
   const auth=await oauth.parseAuthRequest(request),details=await oauth.describeConsent(auth),consent=await oauth.beginConsent(auth);consent.headers.set('Content-Type','text/html; charset=utf-8');
   return new Response(`<!doctype html><meta charset="utf-8"><title>Book Harvester</title><h1>Book Harvesterへの接続</h1><p>${esc(details.clientName)} → ${esc(details.redirectHost)}</p>${details.clientDomain?`<p>${esc(details.clientDomain)}</p>`:''}${details.redirectIsLoopback?'<p>このコンピューターのアプリへ権限を渡します。</p>':''}<form method="post"><input type="hidden" name="handle" value="${esc(consent.handle)}">${['book:read','book:write','book:manage','offline_access'].map(s=>`<p><label><input type="checkbox" name="scope" value="${s}" checked>${s}</label></p>`).join('')}<button name="decision" value="approve">接続する</button><button name="decision" value="deny">キャンセル</button></form>`,{headers:consent.headers});
  }
  if(request.method!=='POST'||request.headers.get('origin')!==env.MCP_ORIGIN)return new Response('Forbidden',{status:403});
  const form=await request.formData(),handle=String(form.get('handle'));
  if(form.get('decision')!=='approve'){const denied=await oauth.denyConsent(request,handle);return new Response(null,{status:302,headers:denied.headers});}
  const approved=await oauth.approveConsent(request,handle,{scope:form.getAll('scope').map(String)});
  const done=await oauth.completeAuthorization({request:approved.request,userId:env.ACCESS_EMAIL!,metadata:{},scope:approved.request.scope,props:{email:env.ACCESS_EMAIL}});approved.headers.set('Location',done.redirectTo);return new Response(null,{status:302,headers:approved.headers});
 }catch(e){if(e instanceof AuthorizationError&&e.redirectTo)return Response.redirect(e.redirectTo,302);return new Response('Authorization request is invalid or expired',{status:400});}
}};
export default new OAuthProvider<McpEnv>({apiRoute:'/mcp',apiHandler,defaultHandler,authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',scopesSupported:['book:read','book:write','book:manage','offline_access'],requiredScopes:['book:read'],resourceMetadata:{resource:'https://book-harvester-mcp.mashstock.workers.dev/mcp',authorization_servers:['https://book-harvester-mcp.mashstock.workers.dev']},clientIdMetadataDocumentEnabled:true});
