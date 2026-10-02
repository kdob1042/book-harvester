import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../test/helpers.js';
const f=await fixture({key:''});f.env.APP_ORIGIN='http://localhost:8795';
let mode='password',failure=null,loginCalls=0;
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/cdn-cgi/access/logout'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<p>Access reauthentication</p>');return;}
  if(req.url==='/api/login')loginCalls++;
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
  if(failure&&req.url.startsWith('/api/state')){res.writeHead(failure,{'Content-Type':'text/html'});res.end('Access session expired');return;}
  f.env.ACCESS_AUD=mode==='cloudflare_access'?'owner-app':undefined;f.env.ACCESS_EMAIL='owner@example.com';
  const ctx=mode==='cloudflare_access'?{...f.ctx,access:{aud:'owner-app',async getIdentity(){return {email:'owner@example.com'};}}}:f.ctx;
  const response=await f.worker.fetch(new Request(f.env.APP_ORIGIN+req.url,{method:req.method,headers:req.headers,...body.length?{body}:{}}),f.env,ctx);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(e){console.error(e);res.writeHead(500);res.end('Fixture failure');}
});
await new Promise(r=>server.listen(8795,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process','--in-process-gpu']}:{}});
try{
 const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
 await page.goto(f.env.APP_ORIGIN);await page.getByLabel('パスワード',{exact:true}).fill(f.env.APP_PASSWORD);await page.getByRole('button',{name:'開く',exact:true}).click();await expect(page.locator('#record')).toBeVisible();
 await page.locator('.menu>summary').click();await page.locator('#logout').click();await expect(page.locator('#password')).toBeVisible();
 mode='cloudflare_access';loginCalls=0;
 await page.reload();await expect(page.locator('#record')).toBeVisible();await expect(page.locator('#password')).toHaveCount(0);
 // Durable originals must survive locking and navigation, including a Blob.
 await page.evaluate(async()=>{const {deviceDb}=await import('/offline.js');const db=await deviceDb();await new Promise((resolve,reject)=>{const tx=db.transaction(['outbox','meta'],'readwrite');const r=tx.objectStore('meta').get('active');r.onsuccess=()=>tx.objectStore('outbox').put({id:'retained',scope:r.result.scope,body:new Blob(['original']),created_at:1,state:'conflict'});tx.oncomplete=resolve;tx.onerror=reject;});});
 await page.locator('.menu>summary').click();await page.locator('#logout').click();await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
 await page.goto(f.env.APP_ORIGIN);await expect(page.locator('#record')).toBeVisible();
 await page.evaluate(async()=>{const {deviceDb}=await import('/offline.js');const db=await deviceDb();const original=await new Promise(r=>{const q=db.transaction('outbox').objectStore('outbox').get('retained');q.onsuccess=()=>r(q.result);});if(await original.body.text()!=='original')throw Error('Original lost');});
 for(const status of [401,403]){
  failure=status;await page.goto(f.env.APP_ORIGIN);await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);await expect(page.locator('#password')).toHaveCount(0);
  failure=null;await page.goto(f.env.APP_ORIGIN);await expect(page.locator('#record')).toBeVisible();
 }
 await page.evaluate(()=>window.dispatchEvent(new Event('device-auth-expired')));await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
 if(loginCalls!==0)throw Error('Access mode called password API');
 console.log('Auth browser passed: initial 401/403 HTML, Access logout/reentry, device expiry, retained Blob/outbox, local password login.');
 await context.close();
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
