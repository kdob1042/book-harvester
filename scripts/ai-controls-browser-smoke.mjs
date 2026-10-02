import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
const files=new Map([['/',new URL('../test/fixtures/ai-controls.html',import.meta.url)],...['ai-controls.js','ai-action-contract.js','ai-controls.css'].map(n=>[`/${n}`,new URL(`../public/${n}`,import.meta.url)])]);
const server=createServer(async(req,res)=>{const file=files.get(req.url);if(!file){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript; charset=utf-8':req.url.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(await readFile(file));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch(),page=await browser.newPage(),canceled=new Set(),bad=new Set(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
try{
 await page.route('**/api/ai-operations**',async route=>{
  const path=new URL(route.request().url()).pathname.slice('/api/ai-operations'.length);let body;
  if(path.endsWith('/cancel')){const id=path.split('/')[1];if(bad.has(id)){await route.fulfill({status:503,json:{error:'offline'}});return;}canceled.add(id);body={id,state:'canceled'};}
  else if(!path)body={operations:[]};else{const id=path.slice(1);body={id,state:canceled.has(id)?'canceled':'running'};}
  await route.fulfill({json:body});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);
 await page.click('#open');await page.click('#go');await expect(page.locator('#dialog #ai-controls')).toBeVisible();await expect(page.locator('#ai-controls')).toContainText('深掘り');await page.waitForFunction(()=>pending.length===1);
 await expect(page.locator('#go')).toBeDisabled();await expect(page.locator('#input')).toHaveValue('調べる方向');
 await page.locator('.ai-control-stop').focus();await page.keyboard.press('Enter');await expect(page.locator('.ai-control')).toHaveAttribute('data-state','canceled');
 // Deliberately ignore abort in the fake provider to test late-result suppression.
 await page.evaluate(()=>pending[0].resolve({answer:'late'}));await page.waitForFunction(()=>failures.length===1);assert.equal(await page.evaluate(()=>applied.length),0);await expect(page.locator('#go')).toBeEnabled();
 await page.click('#close');await page.click('#main-ai');await page.waitForFunction(()=>pending.length===2);await expect(page.locator('body > #ai-controls')).toBeVisible();
 await page.click('#open');await expect(page.locator('#dialog #ai-controls')).toBeVisible();await page.evaluate(()=>openDialog());await expect(page.locator('#dialog #ai-controls')).toBeVisible();await page.click('#close');await expect(page.locator('body > #ai-controls')).toBeVisible();
 const secondId=await page.locator('.ai-control[data-state=running]').last().getAttribute('data-operation'),second=page.locator(`[data-operation="${secondId}"]`);
 bad.add(secondId);await second.locator('button').click();await expect(second).toHaveAttribute('data-state','unknown');await expect(second).toContainText('停止を確認できません');bad.delete(secondId);
 await second.locator('button').click();await expect(second).toHaveAttribute('data-state','canceled');await page.evaluate(()=>pending[1].resolve({answer:'late2'}));await page.waitForFunction(()=>failures.length===2);assert.equal(await page.evaluate(()=>applied.length),0);
 await page.setViewportSize({width:320,height:568});await page.emulateMedia({reducedMotion:'reduce'});await page.click('#open');await page.click('#go');await page.waitForFunction(()=>pending.length===3);
 const active=page.locator('.ai-control[data-state=running]').last();await expect(active).toBeVisible();assert.ok((await active.locator('button').boundingBox()).height>=44);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await active.locator('.ai-control-spinner').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.evaluate(()=>pending[2].resolve({answer:'kept'}));await page.waitForFunction(()=>applied.length===1);await expect(page.locator('#go')).toBeEnabled();
 // A manual candidate save is not an AI launch.
 const before=await page.locator('.ai-control').count();await page.evaluate(async()=>{const {requestWithAIControls}=await import('/ai-controls.js');await requestWithAIControls('/api/themes/t/drilldown/candidates',{method:'POST'},async()=>({ok:true}));});assert.equal(await page.locator('.ai-control').count(),before);
 assert.deepEqual(errors,[]);console.log('AI controls: modal/global, keyboard stop, late result, remount, stop failure/retry, mobile and reduced-motion passed.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
