import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
import {fixture,result,graphResponse,mockAi,setProviderDouble} from '../test/helpers.js';

const f=await fixture({policy:'explicit'});
f.env.APP_ORIGIN='http://localhost:8797';
let calls=[],drain=true,failExtraction=false;
const ai=async(url,options)=>{
 const p=JSON.parse(options.body),name=p.text?.format?.name;
 calls.push(name);
 if(name==='capture_harvest_v1'){
  if(failExtraction)return new Response('Rejected fixture',{status:400});
  const text=JSON.parse(p.input[0].content[0].text).original_or_corrected_text,h=result();
  h.extracted_text=text;h.summary=text;h.claims[0].text=text;h.claims[0].evidence.quote=text;
  return graphResponse({},h);
 }
 if(name==='discovery_search_plan_v1')return graphResponse({},{queries:[{kind:'direct',terms:['供給','制約']}]});
 if(name==='related_discovery_v1'){
  const input=JSON.parse(p.input);
  return graphResponse({},{candidates:input.candidates.filter(c=>c.kind!=='theme').map(c=>({id:c.id,reason:'供給不足と価格の関係を比較できる',relation:'condition',relevance:3})),destination:{theme_id:'theme:work',question:'専門性の価値は、何によって変わるのか？',content:null,scope:'仕事',exclusions:''}});
 }
 return mockAi(url,options);
};
setProviderDouble(ai);
const server=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks),response=await f.worker.fetch(new Request(f.env.APP_ORIGIN+req.url,{method:req.method,headers:req.headers,...body.length?{body}:{}}),f.env,f.ctx);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  if(drain)await f.drain(ai);
 }catch(e){console.error(e);if(!res.headersSent)res.writeHead(500);res.end();}
});
await new Promise(r=>server.listen(8797,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']}:{}});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.env.APP_ORIGIN);await page.locator('#password').fill(f.env.APP_PASSWORD);await page.locator('#login-form button').click();
 const write=async text=>{await page.locator('#record').click();await page.locator('#capture-mode').selectOption('text');await page.locator('#capture-text').fill(text);};
 const yes=()=>page.getByRole('button',{name:'はい、実行する',exact:true}).click();
 await write('供給の制約を記録する。');await page.locator('#text-form button').click();
 await expect(page.locator('#dialog')).not.toBeVisible();
 if(calls.length)throw Error('Ordinary save ran AI');
 await page.reload();await expect(page.locator('#record')).toBeVisible();
 if(calls.length)throw Error('Reload ran AI');
 // An existing parsed record supplies a concrete related candidate.
 const existing=f.db.prepare('SELECT id FROM captures').get(),harvest=result();
 f.db.prepare('INSERT INTO harvests(capture_id,version,result,created_at) VALUES(?,1,?,0)').run(existing.id,JSON.stringify(harvest));
 await write('供給不足の条件を考える。');await page.locator('#save-find-related').click();
 await page.getByRole('button',{name:'いいえ',exact:true}).click();
 await expect(page.locator('#capture-text')).toHaveValue('供給不足の条件を考える。');
 if(calls.length||f.db.prepare('SELECT count(*) n FROM captures').get().n!==1)throw Error('Declined confirmation saved or ran AI');
 await page.locator('#save-find-related').click();await yes();
 await expect(page.locator('#related-candidates')).toContainText('専門性の価値', {timeout:15000});
 await expect(page.locator('[data-related-select]')).toHaveCount(1);
 await expect(page.locator('#related-candidates')).toContainText('供給不足と価格の関係を比較できる');
 await expect(page.locator('.ai-confirmation')).toHaveCount(0);
 if(calls.join(',')!=='capture_harvest_v1,discovery_search_plan_v1,related_discovery_v1')throw Error('Combined action did not execute exactly its authorized steps: '+calls);
 if(f.db.prepare('SELECT count(*) n FROM integration_runs').get().n)throw Error('Discovery integrated without selection');
 const count=calls.length;
 await page.reload();await expect(page.locator('#record')).toBeVisible();
 if(calls.length!==count)throw Error('Combined action resumed on reload');
 // Stop extraction before the next step. The saved original remains.
 drain=false;
 await write('停止する供給制約の記録。');await page.locator('#save-find-related').click();await yes();
 await expect(page.locator('#cancel-extraction')).toBeVisible();await page.locator('#cancel-extraction').click();
 await expect(page.locator('#extract')).toBeVisible();
 await f.drain(ai);drain=true;
 await expect(page.locator('#notice')).toContainText('文章は保存済み', {timeout:5000});
 if(calls.length!==count)throw Error('Stopped extraction started search');
 await page.locator('#back').click();
 failExtraction=true;
 await write('読めない供給制約の記録。');await page.locator('#save-find-related').click();await yes();
 await expect.poll(()=>f.db.prepare('SELECT count(*) n FROM captures').get().n).toBe(4);
 await expect.poll(()=>f.db.prepare("SELECT state FROM jobs j JOIN captures c ON c.id=j.capture_id WHERE c.original_text='読めない供給制約の記録。'").get()?.state).toBe('failed');
 await expect(page.locator('#notice')).toContainText('文章は保存済み', {timeout:15000});
 if(calls.filter(x=>x==='related_discovery_v1').length!==1)throw Error('Failed extraction started search');
 if(f.db.prepare('SELECT count(*) n FROM captures').get().n!==4)throw Error('Originals lost or duplicated');
 if(errors.length)throw Error(errors.join('\n'));
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
 console.log('Text discovery browser passed: ordinary save/reload, declined confirmation, one confirmed extraction+search, no automatic integration, stop and extraction failure preserve originals.');
}finally{
 setProviderDouble(null);await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();
}
