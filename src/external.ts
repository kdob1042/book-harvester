import {isIP} from 'node:net';
import {plainHtml,parseDocument} from './import-parsers.ts';
import {boundedBody,digest} from './core.ts';
export const defaultHosts=['arxiv.org','export.arxiv.org','pmc.ncbi.nlm.nih.gov','pubmed.ncbi.nlm.nih.gov','www.sec.gov','www.federalreserve.gov','www.bls.gov','www.boj.or.jp','www.meti.go.jp','www.stat.go.jp','www.jstage.jst.go.jp','ndlsearch.ndl.go.jp','openlibrary.org','api.worldbank.org','data.worldbank.org','www.nber.org','developers.openai.com','developers.cloudflare.com','www.who.int','www.cdc.gov'];
export function allowedHosts(env:Env){return [...new Set([...defaultHosts,...(env.RESEARCH_ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)])].filter(h=>/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(h)).slice(0,60);}
export function safeExternalUrl(value:string,hosts:string[]){
 if(value.length>2000)throw Error('url_limit');const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||isIP(url.hostname.replace(/[\[\]]/g,''))||!hosts.includes(url.hostname)||url.hostname.endsWith('.')||/\b(?:admin|login|signin|logout|oauth|account|metadata)\b/i.test(url.pathname))throw Error('url_not_allowed');
 url.hash='';for(const name of [...url.searchParams.keys()])if(/^utm_|^(?:fbclid|gclid)$/i.test(name))url.searchParams.delete(name);return url;
}
export function publicIp(ip:string){
 if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return a>0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127)&&!(a===192&&(b===0||b===2))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);}
 // Only global IPv6 unicast, excluding documentation/translation/embedded IPv4 ranges.
 return isIP(ip)===6&&/^[23][0-9a-f]{0,3}:/i.test(ip)&&!/^2001:(?:db8|0(?:0{0,3})?|10|20):/i.test(ip)&&!/^2002:/i.test(ip);
}
async function responseBytes(response:Response,max:number){return boundedBody(new Request('http://localhost',{method:'POST',body:response.body,duplex:'half'} as RequestInit),max);}
async function validateDns(host:string,fetcher:typeof fetch){
 const ips:string[]=[];
 for(const type of ['A','AAAA']){
  const url=`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
  const response=await fetcher(url,{headers:{Accept:'application/dns-json'},signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok){await response.body?.cancel();throw Error('dns_unavailable');}
  const data=JSON.parse(new TextDecoder().decode(await responseBytes(response,16000))) as {Status?:number;Answer?:{type:number;data:string}[]};if(data.Status!==0)throw Error('dns_unavailable');
  for(const record of data.Answer||[])if(record.type===1||record.type===28)ips.push(record.data);
 }
 if(!ips.length||ips.some(ip=>!publicIp(ip)))throw Error('private_destination');
}
const attr=(tag:string,name:string)=>new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`,'i').exec(tag)?.[1]||null;
function meta(html:string,key:string){for(const tag of html.match(/<meta\b[^>]*>/gi)||[])if(attr(tag,'property')===key||attr(tag,'name')===key)return attr(tag,'content');return null;}
export type ExternalMaterial={url:string;canonical_url:string;title:string;body:string;scope:'article'|'abstract'|'excerpt'|'pdf_excerpt';published_at:string|null;retrieved_at:number;content_hash:string;warnings:string[]};
export async function retrieveExternal(env:Env,value:string,fetcher:typeof fetch=fetch):Promise<ExternalMaterial>{
 const hosts=allowedHosts(env);let url=safeExternalUrl(value,hosts),response:Response|undefined;
 for(let hops=0;hops<=3;hops++){
  await validateDns(url.hostname,fetcher);
  response=await fetcher(url.toString(),{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Accept:'text/html,application/pdf,text/plain,application/json','User-Agent':'BookHarvester/0.1 (https://github.com/kdob1042/book-harvester)'}});
  if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location||hops===3)throw Error('redirect_limit');url=safeExternalUrl(new URL(location,url).toString(),hosts);continue;}break;
 }
 if(!response?.ok){await response?.body?.cancel();throw Error(response?.status===401||response?.status===403?'restricted_source':'source_unavailable');}
 const type=response.headers.get('content-type')||'',bytes=await responseBytes(response,type.includes('pdf')?10*1024*1024:1000000);let title=url.hostname,body='',scope:ExternalMaterial['scope']='excerpt',published_at:string|null=null,canonical=url.toString();const warnings:string[]=[];
 if(type.includes('pdf')){const doc=await parseDocument('pdf',bytes);body=doc.sections.slice(0,3).map(x=>`${x.locator}\n${x.body}`).join('\n');scope='pdf_excerpt';title=doc.title||url.pathname.split('/').at(-1)||title;warnings.push('PDFは先頭3ファイルページの取得範囲だけ。');}
 else if(type.includes('html')){
  const html=new TextDecoder().decode(bytes);title=plainHtml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]||meta(html,'og:title')||title).slice(0,500);
  if(/<meta\b[^>]*(?:name=["']robots["'][^>]*content=["'][^"']*nosnippet|content=["'][^"']*nosnippet[^>]*name=["']robots)/i.test(html))throw Error('restricted_source');
  published_at=meta(html,'article:published_time')||meta(html,'citation_publication_date');if(published_at&&(!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(published_at)||published_at.length>100))published_at=null;
  const article=/<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1],main=/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];body=plainHtml(article||main||html.replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,''));scope=article?'article':'excerpt';
  if(/(?:paywall|subscription required|subscribe to read|会員限定|有料会員)/i.test(html)){scope='excerpt';warnings.push('取得できた公開部分だけ。会員・有料本文は未取得。');}
  if(url.hostname==='arxiv.org'&&url.pathname.startsWith('/abs/')||url.hostname==='pubmed.ncbi.nlm.nih.gov')scope='abstract';
  const canonicalTag=(html.match(/<link\b[^>]*>/gi)||[]).find(tag=>attr(tag,'rel')==='canonical');if(canonicalTag){try{canonical=safeExternalUrl(new URL(attr(canonicalTag,'href')||'',url).toString(),hosts).toString();}catch{}}
 }else if(type.includes('text/plain')||type.includes('application/json'))body=new TextDecoder().decode(bytes);else throw Error('unsupported_source_type');
 if(body.trim().length<100)throw Error('insufficient_body');if(body.length>12000){body=body.slice(0,12000);scope=scope==='abstract'?'abstract':'excerpt';warnings.push('本文は先頭12,000文字まで。');}
 return {url:url.toString(),canonical_url:canonical,title,body,scope,published_at,retrieved_at:Date.now(),content_hash:await digest(body),warnings};
}
