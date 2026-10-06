import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
import {fixture,setProviderDouble,json,photo} from '../test/helpers.js';
import {validateDrilldown} from '../src/drilldown.ts';

// Synthetic local data and an explicitly held provider double; no paid AI calls.
const f=await fixture({policy:'explicit'});f.env.APP_ORIGIN='http://localhost:8803';
let releaseAI,calls=0;
const candidates=[{question:'検証に必要な時間は？',content:'検証の条件',reason:'負担を比較する'},{question:'検証の精度を左右する条件は？',content:'精度の比較',reason:'成立条件を確かめる'}];
validateDrilldown({candidates});
const answer=()=>Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({candidates})}]}]});
setProviderDouble(()=>{calls++;return new Promise(resolve=>{releaseAI=()=>resolve(answer());});});
const server=createServer(async(req,res)=>{
 try{
  const parts=[];for await(const chunk of req)parts.push(chunk);const body=Buffer.concat(parts);
  const response=await f.worker.fetch(new Request(f.env.APP_ORIGIN+req.url,{method:req.method,headers:req.headers,...body.length?{body}:{}}),f.env,f.ctx);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{if(!res.headersSent)res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(8803,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true,...process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{},args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
 context.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));page.on('pageerror',error=>errors.push(error.message));
 const confirm=p=>p.getByRole('button',{name:'はい、実行する',exact:true}).click();
 const expand=async p=>{if(!await p.locator('.ai-dock-panel').isVisible())await p.locator('.ai-dock-trigger').click();};
 const start=async()=>{
  await page.locator('[data-theme="theme:work"]').click();await page.getByRole('button',{name:'深掘り',exact:true}).click();
  await page.getByRole('button',{name:'AIで候補を出す',exact:true}).click();await confirm(page);
  await expect.poll(()=>typeof releaseAI).toBe('function');await expand(page);
 };
 await page.goto(f.env.APP_ORIGIN);await page.locator('#password').fill(f.env.APP_PASSWORD);await page.locator('#login-form button').click();
 await expect(page.locator('#record')).toBeVisible();
 // Stop is immediately available while the inline HTTP request/provider is held.
 let stopAttempts=0;
 await page.route('**/api/ai-operations/*/cancel',route=>++stopAttempts===1?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic stop connectivity failure'})}):route.continue());
 await start();await page.getByRole('button',{name:'停止',exact:true}).click();
 await expect(page.getByRole('button',{name:'停止を再試行',exact:true})).toBeVisible();
 await expect(page.locator('.ai-dock-panel')).toContainText('停止を確認できません');
 await page.getByRole('button',{name:'停止を再試行',exact:true}).click();
 await expect(page.locator('.ai-dock-panel')).toContainText('停止済み');
 releaseAI();await expect(page.locator('#drilldown-status')).not.toHaveText('探索中…');
 await expect(page.locator('[data-drilldown-question]')).toHaveCount(0);
 if(f.db.prepare('SELECT count(*) n FROM drilldown_runs').get().n!==0)throw Error('Canceled inline run was saved');
 await page.setViewportSize({width:320,height:700});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Cancellation dock overflowed narrow screen');
 await page.unroute('**/api/ai-operations/*/cancel');
 // Completion wins while the cancel POST is delayed: report completion, not stop.
 await page.reload();await expect(page.locator('#record')).toBeVisible();releaseAI=null;
 let finishCancel;
 const cancelHandled=new Promise(resolve=>{finishCancel=resolve;});
 await page.route('**/api/ai-operations/*/cancel',async route=>{
  releaseAI();await expect.poll(()=>f.db.prepare('SELECT count(*) n FROM drilldown_runs').get().n).toBe(1);await route.continue();finishCancel();
 });
 await start();await page.getByRole('button',{name:'停止',exact:true}).click();
 await expect(page.locator('.ai-dock-panel')).toContainText('深掘り完了');
 await expect(page.locator('.ai-dock-panel')).not.toContainText('停止済み');
 await expect(page.locator('[data-drilldown-question]')).toHaveCount(2);
 await cancelHandled;
 await page.unroute('**/api/ai-operations/*/cancel');
 // Reload reads existing operations only, never starts a new AI request.
 const beforeReload=calls;await page.reload();await expect(page.locator('#record')).toBeVisible();
 await page.waitForTimeout(3500);if(calls!==beforeReload)throw Error('Reload started new AI');
 // Two stale tabs requesting the same queued extraction adopt one canonical ID.
 await f.login();const create=json('POST',{text:'停止後も残す原資料。'});create.headers['Idempotency-Key']=crypto.randomUUID();
 const capture=await (await f.request('/api/captures',create)).json();await f.settle();
 await page.reload();await page.locator(`[data-capture="${capture.id}"]`).click();
 const second=await context.newPage();await second.goto(f.env.APP_ORIGIN);await second.locator(`[data-capture="${capture.id}"]`).click();
 await page.locator('#extract').click();await confirm(page);
 await expect.poll(()=>f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='capture' AND job_id=(SELECT id FROM jobs WHERE capture_id=?)").get(capture.id)?.operation_id).toBeTruthy();
 const canonical=f.db.prepare("SELECT operation_id FROM ai_operation_jobs WHERE kind='capture' AND job_id=(SELECT id FROM jobs WHERE capture_id=?)").get(capture.id).operation_id;
 await second.locator('#extract').click();await confirm(second);await expand(second);
 await expect(second.locator('.ai-dock-task')).toHaveCount(1);
 await second.getByRole('button',{name:'停止',exact:true}).click();
 await expect.poll(()=>f.db.prepare('SELECT state FROM ai_operations WHERE id=?').get(canonical).state).toBe('canceled');
 if(f.db.prepare('SELECT state FROM jobs WHERE capture_id=?').get(capture.id).state!=='canceled')throw Error('Duplicate tab stopped the wrong operation');
 if(!f.db.prepare('SELECT 1 FROM captures WHERE id=?').get(capture.id))throw Error('Stop lost the original');
 if(calls!==beforeReload)throw Error('Queued cancellation ran AI');
 // A canceled import keeps its original and exposes a fresh, confirmed extract.
 const imported=await (await f.request('/api/imports',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:photo('retry-import.png')})).json();await f.settle();
 await page.reload();
 const importButton=page.locator(`[data-import="${imported.id}"]`);
 await importButton.evaluate(button=>{button.closest('details').open=true;});await importButton.click();
 await page.locator('#import-extract').click();await confirm(page);await expand(page);
 await page.getByRole('button',{name:'停止',exact:true}).click();
 await expect(page.locator('#import-extract')).toHaveText('抽出を再試行 · AI');
 await expect(page.locator('article .status')).toHaveText('停止済み');
 // On the narrow viewport the expanded dock covers the lower detail actions.
 await page.locator('[data-ai-focus="collapse"]').click();
 const originalAttemptCount=f.db.prepare('SELECT count(*) n FROM ai_operations WHERE path=?').get(`/api/imports/${imported.id}/extract`).n;
 await page.locator('#import-extract').click();
 await expect(page.getByRole('heading',{name:'AIを実行しますか？',exact:true})).toBeVisible();
 if(f.db.prepare('SELECT count(*) n FROM ai_operations WHERE path=?').get(`/api/imports/${imported.id}/extract`).n!==originalAttemptCount)throw Error('Import retry started before confirmation');
 await page.getByRole('button',{name:'いいえ',exact:true}).click();
 await page.locator('#import-extract').click();await confirm(page);
 await expect.poll(()=>f.db.prepare('SELECT count(*) n FROM ai_operations WHERE path=?').get(`/api/imports/${imported.id}/extract`).n).toBe(originalAttemptCount+1);
 await expand(page);await page.getByRole('button',{name:'停止',exact:true}).click();
 if(calls!==beforeReload)throw Error('Queued import retry called AI');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('Scoped cancellation browser: held inline stop/retry, late result, completion race, narrow dock, read-only reload and duplicate queued tab ownership passed.');
}finally{
 releaseAI?.();setProviderDouble(null);await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();
}
