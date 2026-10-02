// Browser-level checks use synthetic material and mocked AI. No OpenAI request is made.
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {fixture,mockAi} from '../test/helpers.js';

import {a,b,viewA,semanticMock} from '../test/graph-fixtures.js';
let activeAi=mockAi;
const f=await fixture();f.env.APP_ORIGIN='http://localhost:8788';
const server=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks);
  const request=new Request(f.env.APP_ORIGIN+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})});
  const response=await f.worker.fetch(request,f.env,f.ctx);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  // Simulates a queue consumer independently of the browser.
  await f.drain(activeAi);
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
 await page.locator('#capture-mode').selectOption('image');
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
 await page.getByRole('button',{name:'← 残したもの'}).click();
 await page.evaluate(()=>{document.querySelector('#notice').textContent='';});
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'test-results/desktop-feed.png',fullPage:true});
 await expect(page.locator('.primary:visible')).toHaveCount(1);
 await page.getByRole('button',{name:'記録する'}).click();await page.locator('#capture-mode').selectOption('audio');
 await page.getByRole('button',{name:'一言、話す'}).click();await expect(page.locator('#capture-error')).not.toBeEmpty();
 await page.getByText('音声ファイルから残す',{exact:true}).click();await expect(page.locator('#audio-file')).toBeVisible();
 await page.getByRole('button',{name:'閉じる',exact:true}).click();
 activeAi=semanticMock;
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'記録する'}).click();await page.locator('#capture-mode').selectOption('text');await page.locator('#capture-text').fill(a);await page.locator('#capture-source').fill('本A');await page.getByRole('button',{name:'残す',exact:true}).click();
 await page.getByRole('button',{name:new RegExp(a)}).click();await page.getByRole('button',{name:'自分の見方にする',exact:true}).click();await page.getByRole('button',{name:'← 残したもの'}).click();
 await page.getByRole('button',{name:'記録する'}).click();await page.locator('#capture-mode').selectOption('audio');
 const wav=Buffer.alloc(48);wav.write('RIFF',0);wav.write('WAVE',8);
 await page.locator('#audio-file').setInputFiles({name:'book-b.wav',mimeType:'audio/wav',buffer:wav});
 await expect(page.getByRole('dialog')).not.toBeVisible();await page.reload();await page.getByRole('button',{name:new RegExp(b)}).click();
 await expect(page.getByText('過去との接続 · AIの比較',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'この見方に更新',exact:true})).toBeVisible();await expect(page.locator('.primary:visible')).toHaveCount(1);
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Cross-book mobile overflow');
 await page.screenshot({path:'test-results/mobile-cross-book.png',fullPage:true});
 await page.getByText('両側の根拠と違いを読む',{exact:true}).click();await page.getByText('変更する箇所と理由を読む',{exact:true}).click();
 await expect(page.getByRole('link',{name:'本Aの原資料'})).toBeVisible();await expect(page.getByRole('link',{name:'本B · p.1の原資料'})).toBeVisible();
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'test-results/desktop-cross-book.png',fullPage:true});
 await page.getByRole('button',{name:'この接続を表示しない',exact:true}).click();
 await expect(page.getByText('過去との接続 · AIの比較',{exact:true})).not.toBeVisible();
 await expect(page.getByRole('button',{name:'この見方に更新',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'この見方に更新',exact:true}).click();await expect(page.getByText('自分の見方 · 第2版',{exact:true})).toBeVisible();await expect(page.locator('h1')).toContainText('景気の見方は変えない。');
 await page.getByText('見方を編集・履歴を読む',{exact:true}).click();await expect(page.locator('.history')).toHaveCount(2);
 await page.getByRole('button',{name:'← 残したもの'}).click();await page.getByRole('button',{name:new RegExp(a)}).click();await page.getByText('訂正・補足など',{exact:true}).click();await page.getByRole('button',{name:'この記録を削除',exact:true}).click();await page.getByRole('button',{name:'削除する',exact:true}).click();
 const viewRow=page.locator('.view-row').filter({hasText:'利用者の参入しやすさ'});await viewRow.click();await expect(page.getByText('根拠の資料が訂正・削除されています。',{exact:false})).toBeVisible();await expect(page.locator('h1')).toContainText('景気の見方は変えない。');
 if(browserErrors.length)throw new Error(browserErrors.join('\n'));
 console.log('Browser smoke passed: mobile/desktop, 1 primary action, auto-save, revisit, adoption/history, microphone fallback, cross-book evidence/hide, single-action View update, source deletion preserves View, no horizontal overflow.');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}
