// Browser-level checks use synthetic material and mocked AI. No OpenAI request is made.
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../test/helpers.js';

const f=await fixture();f.env.APP_ORIGIN='http://localhost:8788';
const server=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks);
  const request=new Request(f.env.APP_ORIGIN+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})});
  const response=await f.worker.fetch(request,f.env,f.ctx);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  // Simulates a queue consumer independently of the browser.
  await f.drain();
 }catch{res.writeHead(500);res.end('Fixture failure');}
});
await new Promise(resolve=>server.listen(8788,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process','--in-process-gpu','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist']}:{})});
const browserErrors=[];
try{
 await mkdir('test-results',{recursive:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 page.on('pageerror',e=>browserErrors.push(e.message));
 await page.goto(f.env.APP_ORIGIN);await page.getByLabel('パスワード',{exact:true}).fill(f.env.APP_PASSWORD);await page.getByRole('button',{name:'開く',exact:true}).click();
 await expect(page.getByRole('button',{name:'記録する'})).toBeVisible();
 await expect.poll(()=>page.locator('.brand img').evaluate(el=>el.complete&&el.naturalWidth>0)).toBe(true);
 await expect(page.locator('.primary:visible')).toHaveCount(1);
 await page.screenshot({path:'test-results/mobile-empty.png',fullPage:true});
 await page.getByRole('button',{name:'記録する'}).click();
 await expect(page.getByRole('dialog').locator('.primary:visible')).toHaveCount(1);
 await page.screenshot({path:'test-results/mobile-capture.png',fullPage:true});
 await page.locator('#image-file').setInputFiles({name:'page.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64')});
 await expect(page.getByRole('dialog')).not.toBeVisible();
 // The user can leave immediately after original storage; AI is handled by the queue.
 await page.reload();await expect(page.getByRole('button',{name:/供給制約は価格に影響する/})).toBeVisible();
 await page.screenshot({path:'test-results/mobile-feed.png',fullPage:true});
 await page.getByRole('button',{name:/供給制約は価格に影響する/}).click();
 await expect(page.getByRole('button',{name:'自分の見方にする',exact:true})).toBeVisible();await expect(page.locator('.primary:visible')).toHaveCount(1);
 await page.screenshot({path:'test-results/mobile-detail.png',fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw new Error('Mobile horizontal overflow');
 await page.getByRole('button',{name:'自分の見方にする',exact:true}).click();
 await expect(page.getByText('自分の見方に残しました',{exact:true})).toBeVisible();
 await page.getByRole('link',{name:'採用した見方と履歴を読む'}).click();
 await page.getByText('見方を編集・履歴を読む',{exact:true}).click();await page.getByRole('button',{name:'見方を編集する',exact:true}).click();
 await page.locator('#view-body').fill('需要と供給能力を合わせて判断する。');await page.locator('#view-reason').fill('条件を明確にした。');await page.getByRole('button',{name:'見方を更新する'}).click();
 await expect(page.getByText('自分の見方 · 第2版',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'← 本から拾ったもの'}).click();
 await page.evaluate(()=>{document.querySelector('#notice').textContent='';});
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'test-results/desktop-feed.png',fullPage:true});
 await expect(page.locator('.primary:visible')).toHaveCount(1);
 await page.getByRole('button',{name:'記録する'}).click();await page.locator('#capture-mode').selectOption('audio');
 await page.getByRole('button',{name:'一言、話す'}).click();await expect(page.locator('#capture-error')).not.toBeEmpty();
 await page.getByText('音声ファイルから残す',{exact:true}).click();await expect(page.locator('#audio-file')).toBeVisible();
 if(browserErrors.length)throw new Error(browserErrors.join('\n'));
 console.log('Browser smoke passed: mobile/desktop, 1 primary action, auto-save, revisit, adoption/history, microphone fallback, no horizontal overflow.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));f.close();}
