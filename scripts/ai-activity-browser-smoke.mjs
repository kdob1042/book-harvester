import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
import {fixture,setProviderDouble,json} from '../test/helpers.js';

const f=await fixture();f.env.APP_ORIGIN='http://localhost:8799';f.env.AI_EXECUTION_POLICY='explicit';
let resolveAI, rejectAI;
setProviderDouble(()=>new Promise((resolve,reject)=>{resolveAI=resolve;rejectAI=reject;}));
const server=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    const response=await f.worker.fetch(new Request(f.env.APP_ORIGIN+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),f.env,f.ctx);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end();}
});
await new Promise(r=>server.listen(8799,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process','--disable-gpu','--use-gl=angle','--use-angle=swiftshader']});
try{
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.env.APP_ORIGIN);
  await page.getByLabel('パスワード',{exact:true}).fill(f.env.APP_PASSWORD);
  await page.getByRole('button',{name:'開く',exact:true}).click();
  await expect(page.locator('#ai-activity')).toBeHidden();
  await page.locator('[data-theme="theme:work"]').click();
  await page.getByRole('button',{name:'深掘り',exact:true}).click();
  await page.getByRole('button',{name:'AIで候補を出す',exact:true}).click();
  await expect(page.locator('.ai-dock-trigger')).toHaveText('深掘り中');
  await expect.poll(()=>Boolean(resolveAI)).toBe(true);
  // The dock is interactive above a native modal, including its backdrop.
  await page.locator('.ai-dock-trigger').click();
  await expect(page.locator('.ai-dock-panel')).toBeVisible();
  await page.locator('[data-ai-focus="collapse"]').click();
  await page.locator('#close-dialog').click();
  await page.getByRole('button',{name:'← 育てている問い',exact:true}).click();
  await expect(page.locator('.ai-dock-trigger')).toBeVisible();
  // Open an unrelated modal while the original AI request is still running.
  await page.locator('#record').click();
  await page.locator('.ai-dock-trigger').click();
  await expect(page.locator('.ai-dock-panel')).toBeVisible();
  resolveAI(Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({candidates:[{question:'利益は値下げに回るか？',content:'価格競争の条件',reason:'利益率の条件を調べる'},{question:'どの業務で効果が大きいか？',content:'業務の比較',reason:'効果の条件を調べる'}]})}]}]}));
  await expect(page.locator('.ai-dock-trigger')).toContainText('深掘り完了');
  await page.getByRole('button',{name:'見る',exact:true}).click();
  await expect(page.locator('[data-drilldown-question="0"]')).toHaveValue('利益は値下げに回るか？');
  await expect(page.locator('#drilldown-form')).toBeHidden();
  if(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n!==1)throw Error('Opening generated candidates called AI again');
  await page.locator('#close-dialog').click();
  await page.locator('[data-theme="theme:work"]').click();
  await page.getByRole('button',{name:'深掘り',exact:true}).click();
  resolveAI=null;rejectAI=null;
  await page.getByRole('button',{name:'AIで候補を出す',exact:true}).click();
  await expect.poll(()=>Boolean(rejectAI)).toBe(true);
  rejectAI(Error('Synthetic AI failure'));
  await expect(page.locator('.ai-dock-trigger')).toContainText('深掘り失敗');
  await page.locator('#close-dialog').click();
  await page.locator('.ai-dock-trigger').click();
  await expect(page.locator('.ai-dock-panel .error')).toBeVisible();
  // Failure remains until read/dismissed, including on a narrow screen.
  await page.setViewportSize({width:320,height:700});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
  const box=await page.locator('.ai-dock-panel').boundingBox();if(box.x<0||box.x+box.width>320)throw Error('Activity panel escaped narrow viewport');
  await page.getByRole('button',{name:'消す',exact:true}).click();
  await expect(page.locator('#ai-activity')).toBeHidden();
  // A queued extraction stays pending after HTTP acceptance; stopping it keeps
  // the source, and does not pretend that an accepted request is a finished AI run.
  await f.login();
  const options=json('POST',{text:'停止しても原資料は残る。'});options.headers['Idempotency-Key']=crypto.randomUUID();
  const saved=await (await f.request('/api/captures',options)).json();await f.settle();
  await page.getByRole('button',{name:'← 育てている問い',exact:true}).click();
  await page.locator(`[data-capture="${saved.id}"]`).click();
  await page.getByRole('button',{name:'抽出する · AI',exact:true}).click();
  await expect(page.locator('.ai-dock-trigger')).toContainText('知見抽出待ち');
  await page.locator('.ai-dock-trigger').click();
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await expect(page.locator('.ai-dock-trigger')).toContainText('知見抽出停止済み');
  if(f.db.prepare('SELECT count(*) n FROM captures WHERE id=?').get(saved.id).n!==1)throw Error('Cancel removed source');
  if(f.db.prepare('SELECT count(*) n FROM ai_calls').get().n!==2)throw Error('Queued or canceled extraction called AI');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('AI activity: immediate display, modal top layer, navigation, result recovery, failure, mobile and queued cancellation checks passed.');
}finally{
  resolveAI?.(Response.json({output:[]}));
  await browser.close();await new Promise(r=>server.close(r));setProviderDouble(null);await f.close();
}
