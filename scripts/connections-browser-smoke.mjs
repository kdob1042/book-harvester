import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const cap = '11111111-1111-4111-8111-111111111111';
const fixture = {
  themes: [
    { id:'root', question:'AI時代、人の仕事はどう変わる？', content:'自動化と学び直しを考える', state:'active', integration_count:4 },
    { id:'middle', question:'判断する仕事には何が残る？', state:'active', integration_count:2 },
    { id:'leaf', question:'経験は判断の質を高めるか？', state:'active', integration_count:0 },
    { id:'seed', question:'人は何を学び直すべきか？', state:'active', integration_count:0 },
  ],
  branches:[{parent_id:'root',child_id:'middle'},{parent_id:'root',child_id:'seed'},{parent_id:'middle',child_id:'leaf'}],
};
const detail = id => ({ theme:fixture.themes.find(t=>t.id===id),
  result:{understanding:[{text:'仕事の役割は、作業から判断へ変化する。'}],conditions:[],competing:[]},
  children:[{child_kind:'capture',child_id:cap,child_version:1,title:'仕事と学びについての記録'}],
  materials:[{capture_id:cap,capture_version:1,reason:'保存した根拠'}], stale:false });
const capture = {id:cap,version:1,source_title:'読書メモ',page:'12',original_text:'原文には条件と例外がある。',
  harvest:{summary:'仕事と学びについての記録',claims:[{text:'判断には文脈が必要。',evidence:{quote:'経験だけでは十分ではない。'}}]}, assets:[]};
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/connections.css"></head><body><main id="app"><header class="top"><div class="brand">Book Harvester</div><div class="top-actions"><details class="menu"><summary aria-label="メニュー">···</summary><div class="menu-panel"><button>既存の操作</button></div></details></div></header></main><div id="notice" role="status"></div><script type="module" src="/connections-entry.js"></script></body></html>`;
const origin = 'https://book-harvester.test';
const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
let checks = 0;
try {
  for (const viewport of [{width:1280,height:900},{width:390,height:844}]) {
    const mobile = viewport.width === 390;
    const context = await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile});
    const page = await context.newPage(), requests=[], errors=[];
    let mode='normal', delayed=false;
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',msg=>{if(msg.type()==='error'&&/Content Security Policy|Refused to/.test(msg.text()))errors.push(msg.text());});
    // Everything is fulfilled in memory: this test never contacts a live app.
    await page.route('**/*',async route=>{
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) {
        if (path === '/') return route.fulfill({contentType:'text/html',body:html,
          headers:{'content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'"}});
        if (/^\/(connections(?:-model|-viewer|-entry)?\.(js|css)|style\.css)$/.test(path)) {
          return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':'text/css',
            body:await readFile(new URL(`../public${path}`,import.meta.url),'utf8')});
        }
        return route.fulfill({status:404,body:''});
      }
      requests.push({url:route.request().url(),method:route.request().method()});
      if(path==='/api/themes') {
        if(mode==='denied') return route.fulfill({status:403,json:{error:'denied'}});
        if(mode==='failed') return route.fulfill({status:503,json:{error:'failed'}});
        return route.fulfill({json:mode==='empty'?{themes:[],branches:[]}:fixture});
      }
      if(path.startsWith('/api/themes/')) {
        const id=decodeURIComponent(path.split('/').at(-1));
        if(delayed&&id==='leaf')await new Promise(resolve=>setTimeout(resolve,350));
        return route.fulfill({json:detail(id)});
      }
      if(path===`/api/captures/${cap}`)return route.fulfill({json:capture});
      return route.fulfill({status:404,json:{error:'unexpected request'}});
    });
    async function open() {
      const menu=page.locator('.menu');if(!await menu.evaluate(e=>e.open))await page.getByLabel('メニュー',{exact:true}).click();
      await page.getByRole('button',{name:'つながりを見る',exact:true}).click();
      await page.locator('.connections-viewer').waitFor();
    }
    const node = id=>page.locator(`[data-cv-node="${id}"]`);
    await page.goto(origin); await page.waitForSelector('[data-connections-entry]',{state:'attached'});
    const header=await page.locator('#app').innerHTML();
    for(let i=0;i<3;i++)await page.locator('#app').evaluate((e,html)=>{e.innerHTML=html},header);
    assert.equal(await page.locator('[data-connections-entry]').count(),1); checks++;
    await open(); await page.waitForFunction(()=>document.querySelectorAll('[data-cv-node]').length===4);
    await node('theme:root').click(); await page.getByRole('heading',{name:'内容',exact:true}).waitFor();
    assert.equal(await page.locator('.cv-node-capture').count(),1); checks++;
    await node('theme:middle').click(); await page.locator('.cv-detail-head h3').filter({hasText:'判断する仕事'}).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.cv-edge').length===5);
    assert.equal(await page.locator('.cv-node-capture').count(),1); checks++;
    const previousBox = await page.locator('.cv-graph').getAttribute('viewBox');
    await node(`capture:${cap}`).click();
    await page.getByRole('button',{name:'前の項目に戻る',exact:true}).click();
    await page.locator('.cv-detail-head h3').filter({hasText:'判断する仕事'}).waitFor();
    assert.equal(await page.locator('.cv-graph').getAttribute('viewBox'),previousBox); checks++;
    await node(`capture:${cap}`).click(); await page.getByText('原文',{exact:true}).click();
    await page.getByText(capture.original_text,{exact:true}).waitFor(); checks++;
    // Search/zoom/pan are entirely local, including optional question content.
    const count=requests.length;
    await page.getByLabel('表示中の問い・記録を検索').fill('学び直し');
    await page.waitForTimeout(160); assert.ok(await page.locator('[data-cv-node]').count()>0);
    await page.getByLabel('表示中の問い・記録を検索').fill('存在しない問い');
    await page.getByText('見つかりませんでした。',{exact:true}).waitFor();
    await page.getByLabel('表示中の問い・記録を検索').fill(''); await page.waitForTimeout(160);
    const before=await page.locator('.cv-graph').getAttribute('viewBox');
    await page.getByRole('button',{name:'拡大',exact:true}).click();
    const after=await page.locator('.cv-graph').getAttribute('viewBox'); assert.notEqual(before,after);
    await page.getByRole('button',{name:'全体を表示',exact:true}).click();
    assert.equal(requests.length,count); checks++;
    await page.getByRole('button',{name:'選択を解除',exact:true}).click();
    const bounds=await page.locator('.cv-graph').boundingBox();
    const panBefore=await page.locator('.cv-graph').getAttribute('viewBox');
    await page.mouse.move(bounds.x+15,bounds.y+70);await page.mouse.down();await page.mouse.move(bounds.x+55,bounds.y+110,{steps:8});await page.mouse.up();
    assert.notEqual(panBefore,await page.locator('.cv-graph').getAttribute('viewBox'));checks++;
    await page.getByRole('button',{name:'全体を表示',exact:true}).click();
    await node('theme:root').focus(); await page.keyboard.press('Enter');
    await page.getByRole('heading',{name:'内容',exact:true}).waitFor();checks++;
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    if(mobile) {
      await page.getByRole('button',{name:'選択を解除',exact:true}).click();
      const session=await context.newCDPSession(page), b=await page.locator('.cv-graph').boundingBox();
      const x=b.x+b.width/2,y=b.y+b.height/2,pinchBefore=(await page.locator('.cv-graph').getAttribute('viewBox')).split(' ').map(Number);
      const send=(type,distance)=>session.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:x-distance,y,id:1},{x:x+distance,y,id:2}]});
      await send('touchStart',35);await send('touchMove',60);await send('touchMove',80);await send('touchEnd',80);
      const pinchAfter=(await page.locator('.cv-graph').getAttribute('viewBox')).split(' ').map(Number);
      assert.ok(pinchAfter[2]<pinchBefore[2]);checks++;
      await page.getByRole('button',{name:'全体を表示',exact:true}).click();
    }
    // Request races: a slower selection must not overwrite the newer selection.
    delayed=true;await node('theme:leaf').click();await node('theme:seed').click();await page.waitForTimeout(450);
    assert.match(await page.locator('.cv-detail-head h3').textContent(),/学び直す/);checks++;
    if(process.env.CONNECTIONS_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.CONNECTIONS_SCREENSHOT_DIR}/connections-${mobile?'mobile':'desktop'}.png`});
    await page.keyboard.press('Escape');await page.locator('.connections-viewer').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.connectionsEntry),'');checks++;
    const readsBefore=requests.filter(r=>r.url.endsWith('/api/themes')).length;
    mode='empty';await open();await page.getByText('問いはまだありません。',{exact:true}).waitFor();
    assert.equal(requests.filter(r=>r.url.endsWith('/api/themes')).length,readsBefore+1);checks++;
    await page.keyboard.press('Escape');mode='failed';await open();await page.getByRole('button',{name:'再試行',exact:true}).waitFor();
    mode='normal';await page.getByRole('button',{name:'再試行',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-cv-node]').length===4);checks++;
    await page.keyboard.press('Escape');mode='denied';await open();await page.getByRole('button',{name:'ページを開き直す',exact:true}).waitFor();
    assert.equal(await page.locator('[data-cv-node]').count(),0);checks++;
    assert.ok(requests.every(r=>r.method==='GET'));assert.deepEqual(errors,[]);checks++;
    await context.close();
  }
  console.log(`connections browser smoke: ${checks} checks passed (1280px / 390px, touch pinch, CSP, GET-only, races, auth)`);
} finally {await browser.close();}
