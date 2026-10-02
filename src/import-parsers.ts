import {Unzip,UnzipInflate} from 'fflate';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {getDocumentProxy} from 'unpdf';
export type ImportSection={locator:string|null;origin:'source'|'user'|'ai';body:string;note:string};
export type ParsedDocument={title:string|null;sections:ImportSection[];warnings:string[];metadata:Record<string,unknown>};
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
const section=(body:string,locator:string|null,origin:ImportSection['origin']='source',note=''):ImportSection=>({body,locator,origin,note});
export function plainHtml(html:string){
 return html.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[m]||m)).replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c>0&&c<=0x10ffff?String.fromCodePoint(c):'';}).trim();
}
const xml=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',removeNSPrefix:true,processEntities:false,parseTagValue:false});
function readXml(input:string){if(/<!DOCTYPE|<!ENTITY/i.test(input)||XMLValidator.validate(input)!==true)throw Error('invalid_xml');return xml.parse(input);}
const asArray=<T>(value:T|T[]|undefined):T[]=>value===undefined?[]:Array.isArray(value)?value:[value];
function safePath(path:string){if(!path||path.startsWith('/')||path.includes('\\')||path.split('/').includes('..')||path.includes('\0')||/^[a-z]+:/i.test(path))throw Error('unsafe_archive');return path;}
function epubFiles(bytes:Uint8Array){
 const files:Record<string,Uint8Array>=Object.create(null),unzip=new Unzip(file=>{
  safePath(file.name);if(++count>1000||(file.originalSize||0)>8*1024*1024)throw Error('archive_limit');
  if(!/^(mimetype|META-INF\/container.xml)$|\.(opf|xhtml|html|xml)$/i.test(file.name))return;
  if(files[file.name])throw Error('duplicate_archive_entry');let length=0;const chunks:Uint8Array[]=[];
  file.ondata=(err,chunk,final)=>{if(err)throw err;length+=chunk.length;total+=chunk.length;if(total>8*1024*1024||length>2*1024*1024){file.terminate();throw Error('archive_limit');}chunks.push(chunk);if(final){const data=new Uint8Array(length);let offset=0;for(const c of chunks){data.set(c,offset);offset+=c.length;}files[file.name]=data;}};
  file.start();
 });let total=0,count=0;unzip.register(UnzipInflate);
 // Small input chunks bound the inflation performed before the output-limit check.
 for(let i=0;i<bytes.length;i+=256)unzip.push(bytes.subarray(i,i+256),i+256>=bytes.length);
 return files;
}
export async function parseDocument(format:string,bytes:Uint8Array):Promise<ParsedDocument>{
 if(format==='pdf'){
  if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw Error('invalid_pdf');
  const pdf=await getDocumentProxy(bytes,{stopAtErrors:true,useSystemFonts:false,disableFontFace:true});
  try{
   if(pdf.numPages>300)throw Error('page_limit');const sections:ImportSection[]=[],warnings:string[]=[];let total=0;
   for(let n=1;n<=pdf.numPages;n++){
    const page=await pdf.getPage(n),content=await page.getTextContent();const body=content.items.map(item=>'str' in item?item.str+('hasEOL' in item&&item.hasEOL?'\n':' '):'').join('').trim();total+=body.length;if(total>1000000||body.length>20000)throw Error('text_limit');
    sections.push(section(body,`PDF page ${n}`));if(!body)warnings.push(`PDF page ${n}: テキスト取得不能（画像・空白等）。OCRは未実施。`);page.cleanup();
   }
   const meta=await pdf.getMetadata(),info=meta.info as Record<string,unknown>;return {title:typeof info?.Title==='string'?info.Title.slice(0,500):null,sections,warnings,metadata:{pages:pdf.numPages,author:info?.Author||null,locator:'ファイル内ページ番号（印刷ページとは別）'}};
  }finally{await pdf.loadingTask.destroy();}
 }
 if(format==='epub'){
  const files=epubFiles(bytes);if(!files.mimetype||decoder.decode(files.mimetype)!=='application/epub+zip'||files['META-INF/encryption.xml'])throw Error('unsupported_epub');
  const container=readXml(decoder.decode(files['META-INF/container.xml']||new Uint8Array()));const root=asArray<{['@_full-path']:string}>(container.container?.rootfiles?.rootfile)[0];const opfPath=safePath(root?.['@_full-path']);
  const pkg=readXml(decoder.decode(files[opfPath]||new Uint8Array())).package,base=opfPath.includes('/')?opfPath.slice(0,opfPath.lastIndexOf('/')+1):'';
  const entries=asArray<{['@_id']:string;['@_href']:string}>(pkg.manifest?.item),spine=asArray<{['@_idref']:string}>(pkg.spine?.itemref);if(spine.length>300)throw Error('page_limit');
  const sections=spine.map((item,n)=>{const found=entries.find(e=>e['@_id']===item['@_idref']);if(!found)throw Error('invalid_epub');const path=safePath(base+decodeURIComponent(found['@_href'].split('#')[0]));const body=files[path]?plainHtml(decoder.decode(files[path])):'';if(body.length>20000)throw Error('text_limit');return section(body,`EPUB spine ${n+1}: ${path}`);});
  if(!sections.length)throw Error('empty_document');return {title:typeof pkg.metadata?.title==='string'?pkg.metadata.title.slice(0,500):null,sections,warnings:sections.filter(x=>!x.body).map(x=>`${x.locator}: 本文取得不能。`),metadata:{author:pkg.metadata?.creator||null,published_at:pkg.metadata?.date||null,identifier:pkg.metadata?.identifier||null}};
 }
 const input=decoder.decode(bytes);
 if(format==='json'){
  const data=JSON.parse(input);if(input.length>1000000)throw Error('highlight_text_limit');if(data.format!=='book-harvester/highlights-v1'||!Array.isArray(data.items)||data.items.length>100)throw Error('unsupported_highlights');
  const sections=data.items.map((item:Record<string,unknown>,n:number)=>{if(!['source','user','ai'].includes(String(item.origin))||typeof item.text!=='string'||!item.text.trim()||item.text.length>20000||item.note!==undefined&&typeof item.note!=='string'||String(item.note||'').length>20000)throw Error('invalid_highlight');return section(item.text,typeof item.locator==='string'?item.locator.slice(0,1000):`item ${n+1}`,item.origin as ImportSection['origin'],String(item.note||''));});
  return {title:typeof data.source?.title==='string'?data.source.title.slice(0,500):null,sections,warnings:[],metadata:{declared_source:data.source?Object.fromEntries(['title','author','isbn','url'].filter(k=>typeof data.source[k]==='string').map(k=>[k,data.source[k].slice(0,1000)])):null,source_verified:false}};
 }
 if(format==='clippings'){
  const sections:ImportSection[]=[],warnings:string[]=[];let title:string|null=null;
  for(const block of input.split(/^==========\s*$/m).filter(x=>x.trim())){
   const lines=block.trim().split(/\r?\n/),meta=lines[1]||'',body=lines.slice(2).join('\n').trim();if(!body||body.length>20000)throw Error('invalid_clipping');
   const origin=/highlight|ハイライト/i.test(meta)?'source':/note|メモ/i.test(meta)?'user':null;if(!origin){warnings.push('未対応のクリッピング項目を除外（ブックマーク等）。');continue;}
   if(title!==null&&title!==lines[0])throw Error('mixed_books');title=lines[0].slice(0,500);sections.push(section(body,meta.slice(0,1000),origin));
  }if(sections.length>100||!sections.length)throw Error('invalid_clipping');return {title,sections,warnings,metadata:{format:'Kindle My Clippings.txt（Highlight/Note、日本語/英語）',source_verified:false}};
 }
 throw Error('unsupported_format');
}
