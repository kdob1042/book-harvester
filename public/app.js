import {deviceRequest,initDevice,cacheRecent,pendingOperations,discardOperation,clearReadingCache,exportDevice,discardAllOutbox,resolveConflict,resume,lockDevice,deviceSettings,setDeviceSettings} from './offline.js';
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const date = value => new Intl.DateTimeFormat('ja-JP', { month:'short', day:'numeric', timeZone:'Asia/Tokyo' }).format(new Date(value));
const $ = selector => document.querySelector(selector);
let state, currentCapture = null, currentView = null, query = '', recorder = null, stream = null, uploading = false, uploadPending = null;
let searchFilters={source:'',year:'',origin:''};
const searchPath=()=>`/api/state?q=${encodeURIComponent(query)}&source=${encodeURIComponent(searchFilters.source)}&year=${encodeURIComponent(searchFilters.year)}&origin=${encodeURIComponent(searchFilters.origin)}`;
let noticeTimer, searchTimer, pollBusy = false;
const errors = {
  subscription_reauth_required:'原資料は保存済みです。パソコンから ChatGPT に再接続してください。',
  subscription_sharing_usage_limit_exceeded:'原資料は保存済みです。サブスク枠の回復後に再試行します。',
  subscription_audio_unsupported:'音声は保存済みです。サブスク枠では文字起こしできません。文章の記録から知見化できます。',
  ai_not_configured:'原資料は保存済みです。AI設定後に自動で読み取ります。',
  daily_limit:'原資料は保存済みです。今日の解析上限に達しました。明日、自動で続けます。',
  invalid_output:'読み取り結果を確認できませんでした。原資料は残っています。',
  empty_transcript:'音声を読み取れませんでした。原音声は残っています。',
  refused:'この資料は解析できませんでした。原資料は残っています。',
  incomplete_output:'解析結果が途中で止まりました。原資料は残っています。',
  provider_rejected:'解析の設定を確認する必要があります。原資料は残っています。',
};
const statusLabel = c => ({ completed:'', pending:'読み取り待ち', running:'読み取り中', failed:'読み取りできませんでした', blocked:['daily_limit','subscription_sharing_usage_limit_exceeded'].includes(c.error_code) ? '保存済み・上限の回復待ち' : c.error_code==='subscription_audio_unsupported'?'保存済み・音声文字起こしは対象外':c.error_code==='subscription_reauth_required'?'保存済み・ChatGPTの再接続待ち':'保存済み・AI設定待ち', superseded:'新しい版を読み取り中' })[c.state || c.job?.state] || '';
const bind = (selector, event, fn) => $(selector)?.addEventListener(event, fn);

function showNotice(text) {
  clearTimeout(noticeTimer); notice.textContent = text;
  noticeTimer = setTimeout(() => { notice.textContent = ''; }, 4500);
}
async function api(path,options={}){try{return await deviceRequest(path,options);}catch(error){if(error.status===401&&path!=='/api/login'){closeDialog();login();}throw error;}}

const json = (method, data) => ({ method, headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });

function login() {
  if(state?.auth_method==='cloudflare_access'){location.assign('/cdn-cgi/access/logout');return;}
  currentCapture = null; currentView = null; state = null;
  app.innerHTML = `<div class="login"><p class="eyebrow">BOOK HARVESTER</p><h1>読書の続きを、ここから。</h1>
    <form id="login-form"><label><span>パスワード</span><input id="password" type="password" required autocomplete="current-password"></label>
    <p id="login-error" class="error" role="alert"></p><button class="primary" type="submit">開く</button></form></div>`;
  app.removeAttribute('aria-busy');
  bind('#login-form', 'submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await api('/api/login', json('POST', { password:$('#password').value })); await home();resume(); }
    catch (error) { $('#login-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
}

function header(record = true) {
  return `<header class="top"><div class="brand"><img src="/favicon.svg" alt="">Book Harvester</div><div class="top-actions">
    ${record ? '<button id="record" class="primary">記録する<span aria-hidden="true">＋</span></button>' : ''}
    <details class="menu"><summary aria-label="メニュー">···</summary><div class="menu-panel">
    <label><span>記録を検索</span><input id="search" type="search" placeholder="曖昧な言葉でも" value="${esc(query)}"></label>
    <details class="fold"><summary>検索を絞り込む</summary><label><span>本・出典名</span><input id="search-source" value="${esc(searchFilters.source)}"></label><label><span>資料の公開年</span><input id="search-year" inputmode="numeric" maxlength="4" value="${esc(searchFilters.year)}"></label><label><span>発言の由来</span><select id="search-origin"><option value="">すべて</option><option value="source">資料の主張</option><option value="user">本人の発言</option><option value="ai">AIの推論</option></select></label></details><button id="privacy">AIと保存について</button><a href="/api/export" download>すべて書き出す</a>
    <button id="device-menu">端末の保存状況</button><button id="logout">閉じる</button></div></details></div></header>`;
}
function wireHeader() {
  bind('#record', 'click', () => recordDialog());
  bind('#search', 'input', event => {
    query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try { state = await api(searchPath()); renderFeed(); }
      catch (error) { showNotice(error.message); }
    }, 300);
  });
  if($('#search-origin'))$('#search-origin').value=searchFilters.origin;for(const key of ['source','year','origin'])bind(`#search-${key}`,'input',event=>{searchFilters[key]=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{try{state=await api(searchPath());renderFeed();}catch(e){showNotice(e.message);}},400);});
  bind('#privacy', 'click', privacyDialog);
  bind('#device-menu','click',devicePendingDialog);
  bind('#logout', 'click', async () => { try { const result=await api('/api/logout', json('POST', {})); await lockDevice();if(result.redirect){location.assign(result.redirect);return;}login(); } catch (e) { showNotice(e.message); } });
}

async function home() {
  const next = await api(searchPath());
  state = next; currentCapture = null; currentView = null;
  app.innerHTML = `${header()}<section class="intro"><p class="eyebrow">READ · LEAVE · THINK</p>
    <h1>理解を育てる。</h1><p>${state.current_source ? `${esc(state.current_source.title)}<br>前回の本を引き継ぎます。表紙を残すと、本も切り替わります。` : '本の一節も、自分の気づきも。<br>記録から、同じ問いの理解が育ちます。'}</p></section><section id="feed"></section>`;
  app.removeAttribute('aria-busy'); wireHeader(); renderFeed();
  cacheRecent(state).catch(()=>{});
}
function renderFeed() {
  if (!$('#feed')) return;
  notifyReflection(state.reflections||[]);
  const captures = state.captures;
  const deviceInfo=state.device&&(state.device.offline||state.device.pending||state.device.other_scope)?`<p class="subtle">${state.device.offline?'オフライン · 端末の読書キャッシュ':''} ${state.device.pending?`端末に保存・未送信 ${state.device.pending}件`:''} ${state.device.conflicts?`競合 ${state.device.conflicts}件`:''}${state.device.other_scope?' 別の保存先の未送信データは自動送信しません。':''} <button class="quiet" id="device-pending">保存状況を読む</button></p>`:'';
  const searchInfo=query?`<p class="subtle">${state.search_state==='semantic'?'言葉の一致と意味の近さから候補を探しています。意味の検索は索引のある最新1,000件が対象です。根拠は原資料で確認できます。':'言葉の一致から検索しています。意味の索引は設定・処理待ちです。'}</p>`:'';
  $('#feed').innerHTML = `${deviceInfo}${searchInfo}${!query&&!state.filter_active?themeHome(state.theme_index):''}${(state.reflections||[]).map(r=>`<button class="capture-row" data-reflection="${r.id}"><span class="row-meta">${({session:'この区切りの持ち帰り · 記録から推定',day:'一日の振り返り',week:'一週間の振り返り'})[r.scope]}</span><h2>${esc(r.result.summary)}</h2></button>`).join('')}${(state.revisits||[]).map(r=>`<button class="capture-row" data-capture="${r.id}"><span class="row-meta">以前の問いとの再会</span><h2>${esc(r.question)}</h2><p class="subtle">${esc(r.reason)}</p></button>`).join('')}${(state.imports||[]).length&&!query?`<details class="fold"><summary>取り込み状況</summary>${state.imports.map(i=>`<button class="capture-row" data-import="${i.id}"><span class="row-meta">${esc(importState(i.state))}</span>${esc(i.name)}</button>`).join('')}</details>`:''}${(state.research||[]).length&&!query?`<details class="fold"><summary>調査の続きを見る</summary>${state.research.map(r=>`<button class="capture-row" data-research="${r.id}"><span class="row-meta">${esc(researchState(r.state))}</span>${esc(r.question)}</button>`).join('')}</details>`:''}${captures.length ? '<p class="section-label">記録からの知見</p>' : ''}${captures.map(c => {
    const summary = c.harvest?.summary || c.original_preview || (c.kind === 'image' ? '残したページ' : '残した音声');
    const label = c.local_only?(c.local_conflict?'端末に保存・送信できませんでした':'端末に保存・接続後に自動送信'):statusLabel(c);
    const locator = c.page ? ` · ${c.locator_certainty === 'inferred' ? '推定 ' : ''}p.${esc(c.page)}` : '';
    return `<button class="capture-row" data-capture="${c.id}"><span class="row-meta"><span>${c.source_certainty === 'inferred' ? '推定 ' : ''}${esc(c.source_title || (c.import_origin==='user'?'自分のメモ':'出典未確認'))}${c.source_inherited ? '（前回の本）' : ''}${locator}</span><span>${date(c.created_at)}</span></span>
      <h2>${esc(summary)}</h2>${label ? `<span class="status ${esc(c.state)}">${esc(label)}</span>` : `<p class="question-preview">${esc(c.harvest?.questions[0]?.text || '原資料と、考えの続きを読む。')}</p>`}</button>`;
  }).join('')}${!captures.length ? `<div class="empty"><img class="empty-symbol" src="/favicon.svg" alt=""><h2>${query ? 'その言葉は、まだ見つかりません。' : '最初の一枚から、育っていきます。'}</h2><p>${query ? '別の言葉で探してみてください。' : '書名も、ページ番号も、タグも不要です。<br>写真を残したら、本の続きへ。'}</p></div>` : ''}
    ${state.views.length && !query && !state.filter_active ? `<p class="section-label">自分の見方</p>${state.views.map(v => `<button class="view-row" data-view="${v.id}"><span class="row-meta">自分の見方 · 第${v.version}版</span><h2>${esc(v.body)}</h2></button>`).join('')}` : ''}`;
  wireThemeLinks();
  bind('#device-pending','click',devicePendingDialog);
  document.querySelectorAll('[data-capture]').forEach(el => el.addEventListener('click', () => openCapture(el.dataset.capture).catch(e => showNotice(e.message))));
  document.querySelectorAll('[data-import]').forEach(el=>el.addEventListener('click',()=>openImport(el.dataset.import).catch(e=>showNotice(e.message))));
  document.querySelectorAll('[data-research]').forEach(el=>el.onclick=()=>openResearch(el.dataset.research).catch(e=>showNotice(e.message)));
  document.querySelectorAll('[data-reflection]').forEach(el=>el.addEventListener('click',()=>openReflection(el.dataset.reflection).catch(e=>showNotice(e.message))));
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => openView(el.dataset.view).catch(e => showNotice(e.message))));
}

async function openReflection(reflectionId){
 const r=await api(`/api/reflections/${reflectionId}`),v=r.result,input=r.input;currentCapture=null;currentView={id:r.id,reflection:true};
 const capLink=id=>{const c=input.captures.find(c=>c.id===id);return `<a href="#" data-ref-source="${id}">${esc(c?.source_title||'残した資料')}${c?.page?` · p.${esc(c.page)}`:''}</a>`;};
 app.innerHTML=`${header(false)}<button id="back" class="back">← 残したもの</button><article><div class="detail-head"><p class="eyebrow">${({session:'この区切りの持ち帰り · 記録から推定',day:'一日の振り返り',week:'一週間の振り返り'})[r.scope]}</p><h1>${esc(v.summary)}</h1><p class="subtle">保存した箇所の振り返りです。${input.partial?'最新20件の記録に限っています。':''}</p></div>
 ${v.takeaways.map(t=>`<section class="detail-section"><p>${esc(t.text)}</p><p>${t.capture_ids.map(capLink).join(' · ')}</p></section>`).join('')}
 ${v.user_note?`<section class="detail-section"><h2>自分が残した一言</h2><blockquote>${esc(v.user_note.quote)}</blockquote>${capLink(v.user_note.capture_id)}</section>`:''}
 ${v.question_ids.length?`<section class="detail-section"><h2>残った問い</h2>${v.question_ids.map(id=>{const q=input.questions.find(q=>q.id===id);return `<p>${esc(q.text)}<br>${capLink(q.capture_id)}</p>`;}).join('')}</section>`:''}
 ${v.connections.length?`<section class="detail-section"><h2>知見のつながり · AIの整理</h2>${v.connections.map(c=>{const r=input.relations.find(r=>r.id===c.relation_id),p=r?JSON.parse(r.payload):null;return `<details class="fold"><summary>${esc(c.text)}</summary><p>${esc(p?.reason||'')}</p><p class="subtle">条件 ${p?.conditions.map(esc).join('、')||'未確認'}</p>${(p?.evidence||[]).map(e=>`<blockquote>${esc(e.quote||'AI仮説')}<br>${capLink(e.claim_id.split(':')[0])}</blockquote>`).join('')}</details>`;}).join('')}</section>`:''}
 ${v.view_changes.length?`<section class="detail-section"><h2>自分の見方の変化</h2>${v.view_changes.map(x=>`<p>${esc(x.text)}<br><a href="#" data-ref-view="${x.view_id}">採用・改訂した第${x.version}版の履歴</a></p>`).join('')}</section>`:''}
 ${r.scope==='session'?'<details class="fold"><summary>区切りを訂正する</summary><button id="split-session" class="quiet">この中の記録から区切りを分ける</button></details>':''}</article>`;
 wireHeader();bind('#back','click',()=>home().catch(e=>showNotice(e.message)));document.querySelectorAll('[data-ref-source]').forEach(el=>el.addEventListener('click',event=>{event.preventDefault();openCapture(el.dataset.refSource).catch(e=>showNotice(e.message));}));document.querySelectorAll('[data-ref-view]').forEach(el=>el.addEventListener('click',event=>{event.preventDefault();openView(el.dataset.refView).catch(e=>showNotice(e.message));}));
 bind('#split-session','click',()=>{
  modal('読書の区切りを分ける',`<form id="split-form"><label><span>この記録以降を別の区切りにする</span><select id="split-capture">${input.captures.map(c=>`<option value="${c.id}">${esc(c.harvest.summary)}</option>`).join('')}</select></label><p id="split-error" class="error" role="alert"></p><button class="primary">区切りを訂正する</button></form>`);
  bind('#split-form','submit',async event=>{event.preventDefault();try{await api(`/api/reflections/${r.id}/split`,json('POST',{capture_id:$('#split-capture').value}));closeDialog();await home();showNotice('区切りを訂正しました。振り返りは自動で更新します。');}catch(e){$('#split-error').textContent=e.message;}});
 });
}

function modal(title, body) {
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button id="close-dialog" class="quiet" aria-label="閉じる">×</button></div>${body}`;
  if (!dialog.open) dialog.showModal();
  bind('#close-dialog', 'click', closeDialog);
}
function stopRecorder() {
  const previous = recorder; recorder = null;
  if (previous?.state === 'recording') previous.stop();
  stream?.getTracks().forEach(t => t.stop()); stream = null;
}
function closeDialog() {
  if (uploading) return;
  stopRecorder(); dialog.close();
}
dialog.addEventListener('cancel', event => { if (uploading) event.preventDefault(); else stopRecorder(); });

function getMode() { try { return localStorage.getItem('capture-mode') || 'text'; } catch { return 'image'; } }
function setMode(mode) { try { localStorage.setItem('capture-mode', mode); } catch { /* device preferences are optional */ } }

function recordDialog(target = null) {
  uploadPending = null;
  const mode = ['image','audio','text','file','url'].includes(getMode()) ? getMode() : 'text';
  modal(target ? 'この記録に補足する' : '引っかかりを残す', `<label><span>残し方</span><select id="capture-mode" class="capture-mode">
    <option value="image">写真</option><option value="audio">音声</option>${target ? '' : '<option value="url">公開URL</option><option value="text">文章</option><option value="file">PDF・EPUB・ハイライト</option>'}</select></label>
    <div id="capture-body" class="capture-body"></div><p id="capture-error" class="error" role="alert"></p>
    <p class="subtle">${target ? 'いま開いている記録に追加します。' : '思いつきも、読書の一節も。整理は自動で続きます。'}</p>`);
  $('#capture-mode').value = target && mode === 'text' ? 'image' : mode;
  const render = () => {
    stopRecorder(); setMode($('#capture-mode').value);
    const selected = $('#capture-mode').value;
    if(selected==='url'){ $('#capture-body').innerHTML='<form id="url-form"><label><span>公開資料のHTTPS URL</span><input id="source-url" type="url" required></label><p class="subtle">許可済みの一次資料サイトから取得します。本文の取得・知見化に通常2回のAI処理を使います。</p><p id="url-error" class="error"></p><button class="primary">残す</button></form>';bind('#url-form','submit',async e=>{e.preventDefault();try{const r=await api('/api/research',{...json('POST',{url:$('#source-url').value}),headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}});closeDialog();if(r.local){await home();showNotice('調査依頼を端末に保存しました。接続後に開始します。');}else await openResearch(r.id);}catch(err){$('#url-error').textContent=err.message;}});return;}
    $('#capture-error').textContent = '';
    if (selected === 'image') {
      $('#capture-body').innerHTML = `<input id="image-file" type="file" accept="image/jpeg,image/png,image/webp" ${target?'':'multiple'}><button id="pick-image" class="primary">ページを撮る・選ぶ</button><p>表紙や扉の写真から、本も読み取ります。<br>JPEG・PNG・WebP、10MBまで。</p>`;
      bind('#pick-image', 'click', () => $('#image-file').click());
      bind('#image-file', 'change', event => { const files=[...event.target.files];if(files.length>1&&!target)saveImport(files);else if(files[0])saveUpload(files[0],null,target); });
    } else if (selected === 'audio') {
      $('#capture-body').innerHTML = `<button id="record-audio" class="primary">一言、話す</button><p id="record-status">録音を終えると、自動で保存します。</p>
        <details class="fold"><summary>音声ファイルから残す</summary><input id="audio-file" type="file" accept="audio/*,.webm,.m4a"></details>`;
      // A native file picker remains available even if microphone permission is denied.
      bind('#audio-file', 'change', event => { const files=[...event.target.files];if(files.length>1&&!target)saveImport(files);else if(files[0])saveUpload(files[0],null,target); });
      bind('#record-audio', 'click', async () => {
        if (recorder?.state === 'recording') { recorder.stop(); return; }
        try {
          if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('このブラウザでは録音できません。音声ファイルか、写真・文章を使ってください。');
          const recordingStream = await navigator.mediaDevices.getUserMedia({ audio:true });
          if (!dialog.open || $('#capture-mode')?.value !== 'audio') { recordingStream.getTracks().forEach(t => t.stop()); return; }
          stream = recordingStream;
          const mime = ['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
          recorder = new MediaRecorder(stream, mime ? { mimeType:mime } : {});
          const chunks = []; let timer, bytes = 0, overLimit = false;
          const recording = recorder;
          recording.ondataavailable = event => {
            chunks.push(event.data); bytes += event.data.size;
            if (bytes > 10 * 1024 * 1024 && recording.state === 'recording') { overLimit = true; recording.stop(); }
          };
          recording.onstop = () => {
            clearTimeout(timer); recordingStream.getTracks().forEach(t => t.stop());
            // Closing or switching modes cancels recording rather than silently uploading.
            if (!dialog.open || $('#capture-mode')?.value !== 'audio' || recorder !== recording) return;
            const blob = new Blob(chunks, { type:recording.mimeType || 'audio/webm' });
            if (overLimit || blob.size > 10 * 1024 * 1024) { $('#capture-error').textContent = '音声は10MB以下にしてください。'; return; }
            const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
            saveUpload(new File([blob], `recording.${ext}`, { type:blob.type }), null, target);
          };
          recording.onerror = () => { clearTimeout(timer); stopRecorder(); if ($('#capture-error')) $('#capture-error').textContent = '録音できませんでした。音声ファイルから残せます。'; };
          recording.start(1000);
          $('#record-audio').textContent = '話し終わる'; $('#record-status').textContent = '録音中 · 最長2分'; $('#record-status').classList.add('recording');
          timer = setTimeout(() => { if (recording.state === 'recording') recording.stop(); }, 120000);
        } catch (error) { $('#capture-error').textContent = error.name === 'NotAllowedError' ? 'マイクが使えません。音声ファイルか、写真・文章を使ってください。' : error.message; }
      });
    } else if(selected==='file'){
      $('#capture-body').innerHTML='<input id="document-file" type="file" accept=".pdf,.epub,.json,.txt"><button id="pick-document" class="primary">ファイルを選ぶ</button><p>1ファイル10MBまで。PDF・EPUBは保存後に知見化する範囲を選べます。対応ハイライトは自動で取り込みます。</p>';
      bind('#pick-document','click',()=>$('#document-file').click());bind('#document-file','change',event=>{if(event.target.files[0])saveImport([...event.target.files]);});
    } else {
      $('#capture-body').innerHTML = `<form id="text-form"><label><span>残したい文章・一言</span><textarea id="capture-text" maxlength="20000" placeholder="思いついたことを、そのまま" required></textarea></label><label><span>出典（任意）</span><input id="capture-source" maxlength="2000" placeholder="空欄でも、本の名前やメディアのURLでも"></label><button class="primary" type="submit">残す</button></form>`;
      bind('#text-form', 'submit', event => { event.preventDefault(); saveUpload(null, $('#capture-text').value, target); });
    }
  };
  bind('#capture-mode', 'change', render); render();
}

async function saveUpload(file, text, target, reuse = null) {
  if (uploading) return;
  if (file?.size > 10 * 1024 * 1024) { $('#capture-error').textContent = 'ファイルは10MB以下にしてください。'; return; }
  uploading = true;
  const pending = reuse || { file, text, target, source:file?undefined:($('#capture-source')?.value||''), key:crypto.randomUUID() };
  uploadPending = pending;
  $('#capture-error').textContent = '保存しています。';
  dialog.querySelectorAll('button,input,textarea,select').forEach(el => { el.disabled = true; });
  try {
    const headers = { 'Idempotency-Key':pending.key };
    let payload;
    if (file) { payload = new FormData(); payload.set('file', file); }
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify({ text, source:pending.source }); }
    if (target) headers['X-Capture-Version'] = String(target.version);
    await api(target ? `/api/captures/${target.id}/assets` : '/api/captures', { method:'POST', headers, body:payload });
    uploading = false; uploadPending = null; dialog.close();
    if (target) await openCapture(target.id); else await home();
    showNotice('残しました。整理は自動で続きます。');
  } catch (error) {
    uploading = false;
    if (!dialog.open) return;
    $('#capture-error').textContent = error.message;
    dialog.querySelectorAll('button,input,textarea,select').forEach(el => { el.disabled = false; });
    // Keep the same request key and bytes on retry, including after an uncertain network failure.
    $('.upload-retry')?.remove();
    $('#capture-body').querySelectorAll('.primary').forEach(el => { el.hidden = true; });
    const retry = document.createElement('button'); retry.className = 'primary upload-retry'; retry.textContent = 'もう一度保存する';
    retry.addEventListener('click', () => saveUpload(pending.file, pending.text, pending.target, pending));
    $('#capture-body').append(retry);
  }
}

function graphMarkup(graph){
 if(!graph)return '';
 return `${graph.discoveries.length?`<section class="detail-section"><h2>過去との接続 · AIの比較</h2>${graph.discoveries.map(d=>`<div class="knowledge-item"><p>${esc(d.text)}</p><details class="fold"><summary>両側の根拠と違いを読む</summary><p>${esc(d.common_structure)}</p><p class="subtle">相違：${esc(d.important_difference)}</p><p class="subtle">条件：${d.relation.conditions.map(esc).join('、')||'未確定'}</p>${d.relation.evidence.map(e=>`<blockquote>${esc(e.quote||e.text)}<br><a href="#" data-evidence="${esc(e.capture_id)}">${esc(e.source_title||'出典未確認')}${e.page?` · p.${esc(e.page)}`:''}の原資料</a></blockquote>`).join('')}<button class="quiet" data-hide="${esc(d.item_key)}">この接続を表示しない</button></details></div>`).join('')}</section>`:''}
 ${graph.mechanisms.length?`<section class="detail-section"><h2>説明のつながり</h2>${graph.mechanisms.map(m=>`<p>${esc(m.text)}</p><p class="subtle">条件：${m.conditions.map(esc).join('、')}${m.time_lag?` ／ 時間差：${esc(m.time_lag)}`:''}</p>`).join('')}</section>`:''}
 ${['pending','running','blocked'].includes(graph.job?.state)?'<p class="subtle">知見は保存済みです。過去との接続を整理しています。</p>':graph.job?.state==='failed'?'<p class="subtle">今回の知見は保存済みです。過去との接続を整理できませんでした。</p>':''}`;
}

async function openCapture(captureId) {
  currentCapture = await api(`/api/captures/${captureId}`); currentView = null;
  renderCapture();
}
function renderCapture() {
  const c = currentCapture, h = c.harvest, label = statusLabel({ ...c.job, error_code:c.job?.error_code });
  const source = `${c.source_certainty === 'inferred' ? '推定 ' : ''}${esc(c.source_title || (c.import_origin==='user'?'自分のメモ':'出典未確認'))}`;
  const sourceLocator = c.page ? ` · ${c.locator_certainty === 'inferred' ? '推定 ' : ''}p.${esc(c.page)}` : '';
  const adopted = c.views.find(v => v.draft_key === `${c.id}:${c.version}`);
  const graph=c.graph,proposal=graph?.proposal;
  app.innerHTML = `${header(false)}<button id="back" class="back">← 残したもの</button>
    <article><div class="detail-head"><p class="eyebrow">${source}${c.source_inherited ? '（前回の本から引き継ぎ）' : ''}${sourceLocator} · ${date(c.created_at)}</p>
    <h1>${esc(h?.summary || '原資料を残しました。')}</h1>${label ? `<p class="status ${esc(c.job?.state)}">${esc(label)}</p>` : ''}
    ${c.pending_edit?'<p class="subtle">端末の訂正は未送信です。知見は保存先の前の版を表示しています。</p>':''}${c.from_cache?'<p class="subtle">端末に残した資料です。接続時に更新します。</p>':''}${c.local_only?`<p class="subtle">${c.local_conflict?'端末の原資料は残っています。保存状況から失敗内容を確認できます。':'端末の原資料を保存しました。接続後に自動送信・知見化します。'}</p>${c.local_error?`<p class="error">${esc(c.local_error)}</p>`:''}`:''}
    ${['failed','blocked'].includes(c.job?.state) ? `<p class="subtle">${esc(errors[c.job.error_code] || '原資料は残っています。詳細から再試行できます。')}</p>` : ''}</div>
    ${c.themes?.length?`<section class="detail-section"><p class="section-label">この記録が育てる問い</p>${c.themes.map(t=>`<a href="#" data-theme="${esc(t.id)}">${esc(t.question)}</a>`).join('<br>')}</section>`:''}
    ${h?'<section class="detail-section"><button id="find-related" class="primary">関連を探す</button><div id="related-candidates"></div></section>':''}
    ${h?'<details class="fold"><summary>周辺のつながりを読む・概念を整理する</summary><button id="open-neighborhood" class="quiet">この知見の周辺を開く</button></details>':''}
    ${h?'<details class="fold"><summary>問いを外部資料で確かめる</summary><button id="research-start" class="quiet">調べる</button></details>':''}
    ${h ? `<section class="detail-section"><h2>拾った知見</h2>${h.claims.map(claim => `<div class="knowledge-item"><p><span class="origin">${({ source:'資料の主張', user:'自分の発言', ai:'AIの推論' })[claim.evidence.origin]} · ${({ explicit:'記録あり', inferred:'推論', uncertain:'不確か' })[claim.evidence.certainty]}</span></p>
      <p>${esc(claim.text)}</p>${claim.conditions.length ? `<p class="subtle">条件：${claim.conditions.map(esc).join('、')}</p>` : ''}${claim.evidence.quote ? `<blockquote>${esc(claim.evidence.quote)}</blockquote>` : ''}</div>`).join('')}
      ${h.concepts.length ? `<p class="concepts">${h.concepts.map(k => esc(k.name)).join(' · ')}</p>` : ''}</section>
      ${h.questions.length ? `<section class="detail-section"><h2>考えの続き</h2>${h.questions.map(q => `<p>${esc(q.text)}</p>`).join('')}</section>` : ''}
      ${graphMarkup(graph)}
      ${proposal ? `<section class="draft"><h2>見方への影響 · AIの修正案</h2><p class="subtle">${esc(proposal.reason)}</p><details class="fold"><summary>変更する箇所と理由を読む</summary><p class="subtle">いまの文章</p><p class="prose">${esc(proposal.from_text)}</p><p class="subtle">修正案</p><p class="prose">${esc(proposal.to_text)}</p><button class="quiet" data-hide="${esc(`proposal:${proposal.view_id}:${proposal.from_text}:${proposal.to_text}`)}">この案を表示しない</button></details>${proposal.stale?'<p class="subtle">現行の見方が変わっています。関連を探して案を更新できます。</p>':'<button id="adopt-proposal" class="quiet">この見方に更新</button>'}</section>` : h.view_draft ? `<section class="draft"><h2>${adopted ? '自分の見方に残しました' : '見方の案 · AIが考えたこと'}</h2><p class="prose">${esc(h.view_draft.text)}</p><p class="subtle">${esc(h.view_draft.reason)}</p>
      ${adopted ? `<a href="#" id="adopted-view">採用した見方と履歴を読む</a>` : '<button id="adopt" class="quiet">自分の見方にする</button>'}</section>` : ''}
      ${h.uncertainties.length ? `<p class="subtle">読み取りの留保：${h.uncertainties.map(esc).join(' ／ ')}</p>` : ''}` : ''}
    <details class="fold" id="original"><summary>原資料を読む</summary>
      ${c.assets.map(a => a.mime.startsWith('image/') ? `<img class="source-image" src="/api/assets/${a.id}" alt="保存したページ" loading="lazy">` : `<audio controls preload="none" src="/api/assets/${a.id}"></audio>`).join('')}
      ${c.import_ref?`<p class="subtle">${esc(c.import_ref.locator||'位置不明')} · <a href="/api/imports/${c.import_ref.job_id}/original${c.kind==='image'?`/${c.import_ref.ordinal}`:''}" download>原ファイル</a></p>`:''}
      ${c.import_origin?`<p class="subtle">取り込み由来：${({source:'引用・選択範囲',user:'本人メモ',ai:'外部AI回答・出典未検証'})[c.import_origin]}</p>`:''}
      ${c.bibliography?`<details class="fold"><summary>書誌照合 · Open Library</summary><p class="subtle">${c.bibliography.certainty==='identifier_match'?'ISBN一致（版の確定とは別）':'候補・未確定'}</p>${c.bibliography.candidates.map(b=>`<p><a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.title)}</a><br>${b.authors.map(esc).join(' · ')} · 初版年：${esc(b.first_publish_year||'不明')} · 版：${esc(b.edition||'不明')}</p>`).join('')||'一致する書誌なし'}</details>`:''}
      ${/^https?:\/\//i.test(c.source_title||'')?`<p><a href="${esc(c.source_title)}" target="_blank" rel="noopener noreferrer">出典リンクを開く</a> · リンク先本文は未取得</p>`:''}
      ${c.original_text ? `<h3>最初に残した文章</h3><p class="prose">${esc(c.original_text)}</p>` : ''}
      ${h?.extracted_text ? `<h3>読み取った本文・発話</h3><p class="prose">${esc(h.extracted_text)}</p>` : ''}
      ${c.note ? `<h3>自分の一言</h3><p class="prose">${esc(c.note)}</p>` : ''}
      ${c.source_published_at || c.source_subject_period ? `<p class="subtle">${c.source_published_at ? `公開・発行時期：${esc(c.source_published_at)}` : ''}${c.source_subject_period ? `<br>内容の対象時期：${esc(c.source_subject_period)}` : ''}</p>` : ''}</details>
    <details class="fold"><summary>訂正・補足など</summary><div class="secondary-links"><button id="correct">読み取り・出典を訂正</button><button id="supplement">写真・音声を補足</button>
      ${h ? '<button id="ask">この資料について聞く</button><button id="hide-revisit">再訪候補に表示しない</button>' : ''}${['failed','blocked'].includes(c.job?.state) ? '<button id="retry">読み取りを再試行</button>' : ''}<button id="delete" class="danger">この記録を削除</button></div></details></article>`;
  wireHeader(); wireThemeLinks(); bind('#back', 'click', () => home().catch(e => showNotice(e.message)));
  bind('#find-related','click',async event=>{event.target.disabled=true;try{const r=await api('/api/book/discover',json('POST',{id:c.id,version:c.version,idempotency_key:crypto.randomUUID()}));showRelated(r,c);}catch(e){showNotice(e.message);}finally{event.target.disabled=false;}});
  if(h)api(`/api/book/discovery?anchor=${encodeURIComponent(c.id)}`).then(r=>{if(currentCapture?.id===c.id&&r)showRelated(r,c);}).catch(()=>{});
  bind('#adopt', 'click', async event => {
    event.target.disabled = true;
    try { await api(`/api/captures/${c.id}/adopt`, json('POST', { version:c.version })); await openCapture(c.id); showNotice('自分の見方に残しました。'); }
    catch (e) { showNotice(e.message); event.target.disabled = false; }
  });
  bind('#adopted-view', 'click', event => { event.preventDefault(); openView(adopted.id).catch(e => showNotice(e.message)); });
  bind('#correct', 'click', () => correctionDialog(c));
  bind('#supplement', 'click', () => recordDialog(c));
  document.querySelectorAll('[data-evidence]').forEach(el=>el.addEventListener('click',event=>{event.preventDefault();openCapture(el.dataset.evidence).then(()=>$('#original').open=true).catch(e=>showNotice(e.message));}));
  document.querySelectorAll('[data-hide]').forEach(el=>el.addEventListener('click',async()=>{try{await api(`/api/captures/${c.id}/hide`,json('POST',{version:c.version,item_key:el.dataset.hide}));await openCapture(c.id);}catch(e){showNotice(e.message);}}));
  bind('#adopt-proposal','click',async()=>{
   try{const result=await api(`/api/captures/${c.id}/proposal`,json('POST',{version:c.version,proposal_id:proposal.id}));await openView(result.id);showNotice('自分の見方を更新しました。');}
   catch(e){showNotice(e.message);await openCapture(c.id);}
  });
  bind('#ask', 'click', () => {
    modal('この資料について聞く', '<form id="ask-form" class="field-stack"><label><span>短い質問</span><input id="ask-question" required maxlength="1000" placeholder="この条件は、なぜ必要？"></label><p class="subtle">保存した範囲だけで答えます。</p><p id="ask-error" class="error" role="alert"></p><button class="primary">聞く</button></form>');
    bind('#ask-form','submit',async event => {
      event.preventDefault(); const button=event.target.querySelector('button');button.disabled=true;
      try {
        const response=await api(`/api/captures/${c.id}/ask`,json('POST',{version:c.version,question:$('#ask-question').value}));
        modal('この資料からの回答',`<p class="prose">${esc(response.answer)}</p>${response.evidence.map(e=>`<blockquote>${esc(e.quote)}${e.locator?`<br>${esc(e.locator)}`:''}</blockquote>`).join('')}<p class="subtle">資料に限ったAIの説明です。</p>`);
      }catch(e){$('#ask-error').textContent=e.message;button.disabled=false;}
    });
  });
  bind('#open-neighborhood','click',()=>openNeighborhood(c.id));
  bind('#research-start','click',()=>researchDialog({capture_id:c.id,version:c.version},h?.questions[0]?.text||h?.claims[0]?.text||'',c.source_subject_period||h?.source.subject_period||''));
  bind('#hide-revisit','click',async()=>{try{await api('/api/revisit/hide',json('POST',{capture_id:c.id}));showNotice('再訪候補から外しました。記録は残っています。');}catch(e){showNotice(e.message);}});
  bind('#retry', 'click', async () => {
    try { await api(`/api/captures/${c.id}/retry`, json('POST', { version:c.version })); await openCapture(c.id); }
    catch (e) { showNotice(e.message); }
  });
  bind('#delete', 'click', () => {
    modal('この記録を削除する', '<p>原資料とAI解析を削除します。戻せません。採用した見方と履歴は残し、根拠が削除されたことを表示します。</p><p id="delete-error" class="error" role="alert"></p><button id="confirm-delete" class="primary">削除する</button>');
    bind('#confirm-delete', 'click', async () => {
      try { await api(`/api/captures/${c.id}`, json('DELETE', { version:c.version })); closeDialog(); await home(); showNotice('削除しました。'); }
      catch (e) { $('#delete-error').textContent = e.message; }
    });
  });
}

function correctionDialog(c) {
  modal('読み取り・出典を訂正', `<form id="correction-form" class="field-stack">
    <label><span>読み取った本文・発話</span><textarea id="corrected-text" maxlength="20000">${esc(c.corrected_text ?? c.harvest?.extracted_text ?? c.original_text ?? '')}</textarea></label>
    <label><span>自分の一言</span><textarea id="note" maxlength="20000">${esc(c.note)}</textarea></label>
    <label><span>本・出典（空欄でも保存できます）</span><input id="source-title" maxlength="500" value="${esc(c.source_title)}"></label>
    <label><span>ページ</span><input id="page-number" maxlength="100" value="${esc(c.page)}"></label>
    <p id="correction-error" class="error" role="alert"></p><button type="submit" class="primary">訂正を残す</button></form>`);
  bind('#correction-form', 'submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try {
      await api(`/api/captures/${c.id}`, json('PATCH', { version:c.version, corrected_text:$('#corrected-text').value || null, note:$('#note').value, source_title:$('#source-title').value, page:$('#page-number').value }));
      closeDialog(); await openCapture(c.id); showNotice('訂正を残しました。もう一度読み取ります。');
    } catch (e) { $('#correction-error').textContent = e.message; button.disabled = false; }
  });
}

async function openView(viewId) {
  const v = await api(`/api/views/${viewId}`); currentView = v; currentCapture = null;
  app.innerHTML = `${header(false)}<button id="back" class="back">← 残したもの</button><article>
    <div class="detail-head"><p class="eyebrow">自分の見方 · 第${v.version}版</p><h1 class="prose">${esc(v.body)}</h1>${v.pending_edit?'<p class="subtle">端末の編集は未送信です。履歴は保存先の版です。</p>':''}${v.from_cache?'<p class="subtle">端末に残した見方です。接続時に更新します。</p>':''}</div>
    <section class="detail-section"><h2>この見方の根拠</h2><p>${esc(v.revisions[0].references.source_title || '残した資料')}${v.revisions[0].references.page ? ` · p.${esc(v.revisions[0].references.page)}` : ''}</p>
    ${v.evidence_issues?.some(x=>x.capture_id===v.capture_id&&x.state==='deleted')?'': '<a href="#" id="view-source">原資料と解析を読む</a>'}${v.evidence_issues?.length?'<p class="subtle">根拠の資料が訂正・削除されています。この見方の文章は維持しています。採用時の根拠は履歴に残っています。</p>':''}</section>
    <details class="fold"><summary>この見方の根拠の周辺を読む</summary><button id="view-neighborhood" class="quiet">根拠の周辺を開く</button></details><details class="fold"><summary>この見方を外部資料で確かめる</summary><button id="view-research" class="quiet">調べる</button></details><details class="fold"><summary>見方を編集・履歴を読む</summary><button id="edit-view" class="quiet">見方を編集する</button>
    ${v.revisions.map(r => `<div class="history"><p class="subtle">第${r.version}版 · ${date(r.created_at)}</p><p class="prose">${esc(r.body)}</p><p class="subtle">${esc(r.reason)}</p><details class="fold"><summary>採用時の根拠を読む</summary><p>${esc(r.references.source_title||'出典未確認')}</p>${r.references.harvest_snapshot?.claims?.map(c=>`<blockquote>${esc(c.evidence.quote||c.text)}</blockquote>`).join('')||''}${r.references.evidence?.map(e=>`<blockquote>${esc(e.quote||e.snapshot?.text||'AI推論')}</blockquote>`).join('')||''}</details>${r.version !== v.version ? `<button data-restore="${r.version}">この版へ戻す</button>` : ''}</div>`).join('')}</details></article>`;
  wireHeader(); bind('#back','click', () => home().catch(e => showNotice(e.message)));
  bind('#view-neighborhood','click',()=>openNeighborhood(v.capture_id));
  bind('#view-research','click',()=>researchDialog({view_id:v.id,version:v.version},v.body,v.revisions[0]?.references.harvest_snapshot?.source?.subject_period||''));
  bind('#view-source','click', event => { event.preventDefault(); openCapture(v.capture_id).catch(e => showNotice(e.message)); });
  bind('#edit-view','click', () => {
    modal('自分の見方を編集', `<form id="view-form" class="field-stack"><label><span>今の見方</span><textarea id="view-body" required maxlength="20000">${esc(v.body)}</textarea></label>
      <label><span>変えた理由</span><input id="view-reason" required maxlength="2000"></label><p id="view-error" class="error" role="alert"></p><button class="primary">見方を更新する</button></form>`);
    bind('#view-form','submit', async event => {
      event.preventDefault();
      try { await api(`/api/views/${v.id}`, json('PATCH', { version:v.version, body:$('#view-body').value, reason:$('#view-reason').value })); closeDialog(); await openView(v.id); }
      catch (e) { $('#view-error').textContent = e.message; }
    });
  });
  document.querySelectorAll('[data-restore]').forEach(el => el.addEventListener('click', () => {
    modal('過去の見方へ戻す', `<p>第${el.dataset.restore}版の文章を、新しい版として残します。</p><p id="restore-error" class="error" role="alert"></p><button id="restore-confirm" class="primary">この版へ戻す</button>`);
    bind('#restore-confirm','click', async () => {
      try { await api(`/api/views/${v.id}`, json('PATCH', { version:v.version, restore_version:Number(el.dataset.restore) })); closeDialog(); await openView(v.id); }
      catch (e) { $('#restore-error').textContent = e.message; }
    });
  }));
}

function notifyReflection(reflections){
 try{
  if(localStorage.getItem('reflection-notifications')!=='on'||!window.Notification||Notification.permission!=='granted')return;
  const notified=JSON.parse(localStorage.getItem('reflection-notified-ids')||'[]');
  const fresh=reflections.find(r=>Date.now()-r.created_at<86400000&&!notified.includes(r.id));
  if(!fresh)return;
  const notification=new Notification('読書の振り返りができました',{body:fresh.result.summary.slice(0,100),tag:'book-reflection'});
  localStorage.setItem('reflection-notified-ids',JSON.stringify([...notified,fresh.id].slice(-50)));notification.onclick=()=>{window.focus();openReflection(fresh.id).catch(e=>showNotice(e.message));notification.close();};
 }catch{showNotice('通知できませんでした。振り返りはこの画面で読めます。');}
}
function privacyDialog() {
  modal('AIと保存について', `<div class="privacy"><p>残した写真・音声・文章は、このアプリの非公開データとして保存します。</p>
    <p>解析には、対象の原資料、自分の一言、前回の書名だけをOpenAIへ送ります。横断接続には、過去の関連候補を最大12記録・120ノードと、現行の見方を最大6件送ります。通常保存は読み取りまでです。関連探索とテーマの理解の更新は、ボタンで依頼した時だけ実行します。</p>
    <p>AIが作るのは知見と見方の案です。「自分の見方にする」を選んだ文章だけが、本人の見方として残ります。</p>
    <p class="subtle">${state?.ai_configured ? 'AI解析は設定済みです。' : 'AI解析は未設定です。原資料を保存して待ちます。'}<br>今日の呼び出し ${state?.usage.calls || 0} / ${state?.daily_limit || '—'}（UTC日次）。写真・文章は読み取りと横断整理で通常2回、${state?.ai?.mode==='chatgpt'?'音声は原資料の保存のみ。':'音声は文字起こしを含めて通常3回。'}<br>${state?.ai?.mode==='chatgpt' ? 'AI解析は ChatGPT のサブスク枠のみを使います。有料APIへの自動切り替えはありません。音声文字起こしと意味索引は使わず、検索は語句検索です。接続状態：'+esc(state.ai.state)+ '。' : '解析と意味索引は有料APIを使います。上限は呼び出し数です。'}</p>
    <p class="subtle">保存した記録と採用履歴から、区切り・日・週の振り返りを自動で整理します。最大20記録・10改訂をAI処理へ送ります。</p>
    ${state?.ai?.mode==='chatgpt'?'<p>ChatGPT の接続はパソコンから設定できます。上限や接続切れの間は原資料を保存して待ちます。</p><button id="chatgpt-disconnect" class="quiet danger">ChatGPT 接続を解除</button>':''}<details class="fold"><summary>振り返りの通知</summary><p class="subtle">このアプリを開いている間の通知です。既定はオフ。本文が端末の通知に表示されます。</p><label><input id="reflection-notifications" type="checkbox"> 通知を使う</label><p id="notification-error" class="error" role="alert"></p></details>
    <details class="fold"><summary>端末の保存とオフライン</summary><p>最近20記録・10件の見方と、取得できた原資料を自動で端末に残します。読書キャッシュは最大20MB、未送信の原資料は別枠で最大50MBです。端末側の保存領域が削除されると未送信データを失うため、接続時の同期または書き出しで残せます。</p><label><span>最近の記録を残す件数</span><select id="device-record-count"><option>5</option><option selected>20</option><option>50</option></select></label><label><span>読書キャッシュの容量（MB）</span><select id="device-cache-mb"><option>5</option><option selected>20</option><option>40</option></select></label><label><span>未送信原資料の容量（MB）</span><select id="device-outbox-mb"><option>20</option><option selected>50</option></select></label><p class="subtle">設定を減らしても、未送信の原資料は自動で削除しません。</p><button id="device-status" class="quiet">未送信・競合を見る</button><button id="device-clear-cache" class="quiet">読書キャッシュだけ削除</button><button id="device-export" class="quiet">未送信の原資料を書き出す</button><button id="device-discard" class="quiet danger">未送信の原資料をすべて削除</button><p id="device-error" class="error"></p></details><p class="subtle">削除は記録の詳細から。書き出しには元ファイルと履歴も含みます。</p></div>`);
  bind('#chatgpt-disconnect','click',async()=>{try{await api('/api/ai/disconnect',{method:'POST'});state.ai.state='disconnected';state.ai_configured=false;closeDialog();showNotice('ChatGPT 接続を解除しました。');}catch(e){showNotice(e.message);}});
  deviceSettings().then(s=>{if($('#device-record-count')){$('#device-record-count').value=s.cache_records;$('#device-cache-mb').value=s.cache_mb;$('#device-outbox-mb').value=s.outbox_mb;}}).catch(e=>showNotice(e.message));for(const field of ['#device-record-count','#device-cache-mb','#device-outbox-mb'])bind(field,'change',async()=>{try{await setDeviceSettings({cache_records:Number($('#device-record-count').value),cache_mb:Number($('#device-cache-mb').value),outbox_mb:Number($('#device-outbox-mb').value)});showNotice('端末保存の設定を更新しました。未送信データは保持します。');}catch(e){$('#device-error').textContent=e.message;}});
  bind('#device-status','click',devicePendingDialog);bind('#device-clear-cache','click',async()=>{await clearReadingCache();showNotice('読書キャッシュを削除しました。未送信の原資料は残しています。');});bind('#device-export','click',downloadDevice);bind('#device-discard','click',()=>confirmDiscard(null));
  try{$('#reflection-notifications').checked=localStorage.getItem('reflection-notifications')==='on';}catch{}
  bind('#reflection-notifications','change',async event=>{
   try{if(event.target.checked){if(!window.Notification||await Notification.requestPermission()!=='granted')throw Error('通知は許可されていません。画面で読めます。');}localStorage.setItem('reflection-notifications',event.target.checked?'on':'off');$('#notification-error').textContent='';}
   catch(e){event.target.checked=false;try{localStorage.setItem('reflection-notifications','off');}catch{}$('#notification-error').textContent=e.message;}
  });
}

// Poll only small summaries. Never replace an open editor or an expanded source while reading.
setInterval(async () => {
  if (!state || document.hidden || dialog.open || uploading || pollBusy) return;
  pollBusy = true;
  try {
    if (currentCapture && (['pending','running','blocked'].includes(currentCapture.job?.state)||['pending','running','blocked'].includes(currentCapture.graph?.job?.state)||['pending','running','blocked'].includes(currentCapture.membership_job?.state))) {
      if (!app.querySelector('details[open]')) {
        const fresh = await api(`/api/captures/${currentCapture.id}`);
        if (fresh.job?.state !== currentCapture.job?.state || fresh.version !== currentCapture.version || fresh.graph?.job?.state !== currentCapture.graph?.job?.state || fresh.graph?.generation_id !== currentCapture.graph?.generation_id || fresh.membership_job?.state !== currentCapture.membership_job?.state) { currentCapture = fresh; renderCapture(); }
      }
    } else if(currentView?.theme&&['pending','running','blocked'].includes(currentView.job_state)&&!app.querySelector('details[open]')){const fresh=await api(`/api/themes/${encodeURIComponent(currentView.id)}`);if(fresh.revision!==currentView.revision||fresh.job?.state!==currentView.job_state)await openTheme(currentView.id);
    } else if (!currentCapture && !currentView) {
      state = await api(searchPath()); renderFeed();
    }
  } catch (e) { if (e.status !== 401) { /* Preserve the last readable page during a temporary outage. */ } }
  finally { pollBusy = false; }
}, 2500);

home().catch(error => { if (error.status !== 401) { app.innerHTML = '<p class="loading">接続を確認して、ページを開き直してください。</p>'; } });

const importState=value=>({pending:'保存済み・取り込み待ち',running:'取り込み中',ready:'範囲を選択できます',completed:'取り込み済み',partial:'一部失敗・成功分は保存済み',failed:'取り込みできませんでした'})[value]||value;
async function saveImport(files,reuse=null){
 if(uploading)return;if(files.length>12||files.some(f=>f.size>10*1024*1024)||files.reduce((n,f)=>n+f.size,0)>20*1024*1024){$('#capture-error').textContent='1ファイル10MB、合計20MB、写真12枚までです。';return;}
 const pending=reuse||{files,key:crypto.randomUUID()};uploading=true;dialog.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);$('#capture-error').textContent='原ファイルを保存しています。';
 try{const body=new FormData();for(const file of pending.files)body.append('file',file);const saved=await api('/api/imports',{method:'POST',headers:{'Idempotency-Key':pending.key},body});uploading=false;dialog.close();if(saved.local){await home();showNotice('原ファイルを端末に保存しました。接続後に取り込みます。');}else await openImport(saved.id);}
 catch(e){uploading=false;$('#capture-error').textContent=e.message;dialog.querySelectorAll('button,input,select').forEach(el=>el.disabled=false);$('#capture-body').querySelectorAll('.primary').forEach(el=>el.hidden=true);$('.upload-retry')?.remove();const retry=document.createElement('button');retry.className='primary upload-retry';retry.textContent='もう一度保存する';retry.onclick=()=>saveImport(pending.files,pending);$('#capture-body').append(retry);}
}
async function openImport(jobId){
 const job=await api(`/api/imports/${jobId}`);currentCapture=null;currentView={id:jobId,import:true};
 app.innerHTML=`${header(false)}<button id="back" class="back">← 残したもの</button><article><div class="detail-head"><p class="eyebrow">取り込み</p><h1>${esc(job.metadata.title||job.name)}</h1><p class="status">${esc(importState(job.state))}</p><p class="subtle">保存 ${job.items.filter(i=>i.capture_id).length}件 ／ 選択 ${job.items.filter(i=>i.selected).length}件 ／ 範囲 ${job.items.length}件</p></div>
 ${job.metadata.warnings?.length?`<details class="fold"><summary>取得できない範囲</summary>${job.metadata.warnings.map(w=>`<p class="subtle">${esc(w)}</p>`).join('')}</details>`:''}
 ${['pdf','epub'].includes(job.format)&&job.items.length?`<form id="import-select"><p class="subtle">読んだ箇所・知見化したい範囲だけ選択します。1回20件まで、1件は知見化・横断整理で通常2回のAI処理。未選択の本文はAIへ送りません。</p>${job.items.map(i=>`<details class="fold"><summary>${i.state==='deleted'?'削除済み':esc(i.locator||`範囲 ${i.ordinal}`)}${i.capture_id?' · 保存済み':''}</summary><p class="prose">${esc(i.preview||'本文取得不能')}</p>${i.state!=='deleted'&&!i.capture_id&&i.preview?`<label><input type="checkbox" name="ordinal" value="${i.ordinal}"> この範囲を取り込む</label>`:''}${i.capture_id?`<a href="#" data-import-capture="${i.capture_id}">知見と原文を読む</a>`:''}</details>`).join('')}<p id="import-error" class="error" role="alert"></p><button class="primary">選んだ範囲を残す</button></form>`:job.items.map(i=>`<div class="history"><p>${esc(i.locator||`項目 ${i.ordinal}`)} · ${esc(i.state==='saved'?'保存済み':i.state==='deleted'?'削除済み':i.state==='failed'?'失敗':'待機')}</p>${i.capture_id?`<a href="#" data-import-capture="${i.capture_id}">知見と原資料を読む</a>`:''}${i.error_code?`<p class="error">${esc(i.error_code)}</p>`:''}</div>`).join('')}
 ${job.format==='photos'?`<details class="fold"><summary>写真の順序を訂正</summary><form id="import-order"><label><span>写真番号を表示順に並べる</span><input id="import-order-list" value="${job.items.map(i=>i.ordinal).join(', ')}"></label><button class="quiet">順序を反映する</button></form></details>`:''}
 <details class="fold"><summary>原ファイル・再試行・削除</summary>${job.format!=='photos'?`<p><a href="/api/imports/${job.id}/original" download>原ファイルを保存</a></p>`:''}${['failed','partial'].includes(job.state)?'<button id="import-retry" class="quiet">失敗分を再試行</button>':''}<button id="import-delete" class="quiet danger">取り込みと関連記録を削除</button></details></article>`;
 wireHeader();bind('#back','click',()=>home().catch(e=>showNotice(e.message)));document.querySelectorAll('[data-import-capture]').forEach(el=>el.onclick=event=>{event.preventDefault();openCapture(el.dataset.importCapture).catch(e=>showNotice(e.message));});
 bind('#import-select','submit',async event=>{event.preventDefault();try{const ordinals=[...event.target.querySelectorAll('input:checked')].map(x=>Number(x.value));await api(`/api/imports/${job.id}/select`,json('POST',{ordinals}));await openImport(job.id);}catch(e){$('#import-error').textContent=e.message;}});
 bind('#import-order','submit',async event=>{event.preventDefault();try{await api(`/api/imports/${job.id}/order`,json('POST',{ordinals:$('#import-order-list').value.split(',').map(x=>Number(x.trim()))}));await openImport(job.id);}catch(e){showNotice(e.message);}});
 bind('#import-retry','click',async()=>{try{await api(`/api/imports/${job.id}/retry`,json('POST',{}));await openImport(job.id);}catch(e){showNotice(e.message);}});
 bind('#import-delete','click',()=>{modal('取り込みを削除する',`<p>原ファイル、選択範囲と関連する読書記録を削除します。採用した見方と履歴は残ります。</p><button id="import-delete-confirm" class="primary">削除する</button>`);bind('#import-delete-confirm','click',async()=>{try{await api(`/api/imports/${job.id}`,json('DELETE',{}));closeDialog();await home();}catch(e){showNotice(e.message);}});});
 if(['pending','running'].includes(job.state))setTimeout(()=>{if(currentView?.import&&currentView.id===job.id&&!dialog.open)openImport(job.id).catch(e=>showNotice(e.message));},2500);
}

const researchState=s=>({pending:'調査待ち',running:'公開本文を調査中',completed:'調査済み',partial:'一部取得できませんでした',blocked:'AI設定・利用枠待ち',failed:'調査を完了できませんでした',canceled:'停止済み',superseded:'元の問い・資料が更新されました'})[s]||s;
async function researchDialog(context,question,period=''){
 const {hosts}=await api('/api/research/hosts'),key=crypto.randomUUID();
 modal('外部資料を調べる',`<form id="research-form"><label><span>外へ送る問い（この文章だけ）</span><textarea id="research-question" maxlength="1000" required>${esc(question)}</textarea></label><label><span>対象期間（任意・問いと一緒に送信）</span><input id="research-period" maxlength="100" value="${esc(period)}"></label><p class="subtle">本人メモや本の全本文は送信しません。検索1回・比較1回までのAI処理、本文は最大3件。保存した資料には通常2回ずつの知見化処理と、後続の振り返り処理が追加されます。日次利用枠も適用します。</p><details class="fold"><summary>取得できる公開資料サイト</summary><p class="prose">${hosts.map(esc).join('、')}</p></details><p id="research-error" class="error" role="alert"></p><button class="primary">この問いを調べる</button></form>`);
 bind('#research-form','submit',async e=>{e.preventDefault();e.submitter.disabled=true;try{const r=await api('/api/research',{...json('POST',{...context,question:$('#research-question').value,subject_period:$('#research-period').value}),headers:{'Content-Type':'application/json','Idempotency-Key':key}});closeDialog();if(r.local){await home();showNotice('調査依頼を端末に保存しました。接続後に開始します。');}else await openResearch(r.id);}catch(err){$('#research-error').textContent=err.message;e.submitter.disabled=false;}});
}
async function openResearch(runId){
 const r=await api(`/api/research/${runId}`);currentCapture=null;currentView={id:r.id,research:true};const material=id=>r.materials.find(m=>m.id===id);
 app.innerHTML=`${header(false)}<button id="back" class="back">← 残したもの</button><article><div class="detail-head"><p class="eyebrow">外部調査 · AIの検討</p><h1>${esc(r.question)}</h1><p class="status">${esc(researchState(r.state))}</p><p class="subtle">対象期間 ${esc(r.subject_period||'未指定')} · 調査AI ${r.ai_calls}/2回</p>${r.stale?'<p class="subtle">元の記録・見方が変わっています。当時の問いへの調査です。</p>':''}${r.error_code?`<p class="error">${esc(({no_verified_body:'本文を取得できませんでした。検索の断片では結論を作りません。',research_call_limit:'この調査の呼び出し上限に達しました。取得済み資料は残っています。',ai_not_configured:'AI設定後に続行します。'})[r.error_code]||r.error_code)}</p>`:''}</div>
 ${r.result?`<section class="detail-section"><p>${esc(r.result.summary)}</p>${r.result.findings.map(f=>`<div class="knowledge-item"><p class="origin">${({supports:'支持する根拠',challenges:'反証する根拠',qualifies:'条件が付く',unverified:'未確認'})[f.stance]}</p><p>${esc(f.text)}</p>${f.conditions.length?`<p class="subtle">条件：${f.conditions.map(esc).join('、')}</p>`:''}<p class="subtle">出来事の日付 ${esc(f.event_at||'未確認')} · 対象期間 ${esc(f.subject_period||'未確認')}</p>${f.evidence.map(e=>`<blockquote>${esc(e.quote)}<br>${esc(material(e.material_id)?.title)}</blockquote>`).join('')}</div>`).join('')}${r.result.gaps.map(g=>`<p class="subtle">未解決：${esc(g)}</p>`).join('')}${r.result.next_reading.length?`<h2>次に読む資料</h2>${r.result.next_reading.map(n=>`<p><a href="${esc(material(n.material_id)?.url)}" target="_blank" rel="noopener noreferrer">${esc(material(n.material_id)?.title)}</a><br>${esc(n.reason)}</p>`).join('')}`:''}</section>`:''}
 <section class="detail-section"><h2>取得資料と範囲</h2>${r.materials.map(m=>`<details class="fold"><summary>${esc(m.title||m.url)} · ${esc(m.state)}</summary><p><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">公開資料</a></p><p class="subtle">公開日 ${esc(m.published_at||'未確認')} · 取得 ${date(m.retrieved_at)} · ${esc(m.scope)}</p>${m.error_code?`<p class="error">${esc(m.error_code)}</p>`:''}${m.capture_id?`<a href="#" data-research-capture="${m.capture_id}">知見・取得本文・つながりを読む</a>`:''}<p class="prose">${esc(m.body||'本文未取得・削除済み')}</p></details>`).join('')||'<p class="subtle">取得本文を待っています。</p>'}</section>
 <details class="fold"><summary>調査の停止・再試行</summary>${['pending','running','blocked','failed'].includes(r.state)?'<button id="research-cancel" class="quiet">残りの調査を停止</button><p class="subtle">送信済みの有料処理は取り消せません。保存済みの資料は残ります。</p>':''}${['failed','partial','blocked'].includes(r.state)?'<button id="research-retry" class="quiet">未取得分を再試行</button>':''}</details></article>`;
 wireHeader();bind('#back','click',()=>home().catch(e=>showNotice(e.message)));document.querySelectorAll('[data-research-capture]').forEach(el=>el.onclick=e=>{e.preventDefault();openCapture(el.dataset.researchCapture).catch(err=>showNotice(err.message));});
 for(const action of ['cancel','retry'])bind(`#research-${action}`,'click',async()=>{try{await api(`/api/research/${r.id}/${action}`,json('POST',{}));await openResearch(r.id);}catch(e){showNotice(e.message);}});
 if(['pending','running','blocked'].includes(r.state))setTimeout(()=>{if(currentView?.research&&currentView.id===r.id&&!dialog.open)openResearch(r.id).catch(e=>showNotice(e.message));},2500);
}

const graphKind=k=>({claim:'主張',concept:'概念',question:'問い',mechanism:'条件付きのしくみ',view:'本人が採用した見方'})[k]||k;
const relationLabel=k=>({states:'述べる',supports:'支持',challenges:'反証',qualifies:'条件を付ける',analogous_to:'構造が似ている',about:'関連する概念',example_of:'具体例',increases:'増やす',reduces:'減らす',constrains:'制約する',enables:'可能にする',substitutes:'代わりになる',causes:'原因となる',possible_same_as:'同義の可能性'})[k]||k;
async function openNeighborhood(captureId,focus=null){
 try{const g=await api(`/api/graph/neighborhood?capture_id=${encodeURIComponent(captureId)}${focus?`&focus=${encodeURIComponent(focus)}`:''}`),nodes=g.nodes;
 const positions=new Map(nodes.map((n,i)=>[n.id,{x:120+(i%3)*240,y:45+Math.floor(i/3)*105}]));
 modal('この知見の周辺',`<p class="subtle">近い関係だけを表示します。矢印は関係の向きです。概念の共有だけで因果や同意にはなりません。${g.more?'一部を表示中。項目を選ぶと、その周辺へ進めます。':''}</p>
 <svg class="local-graph" viewBox="0 0 720 ${Math.max(140,Math.ceil(nodes.length/3)*105)}" role="img" aria-label="知見の周辺グラフ。項目と根拠は下の一覧でも読めます"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="currentColor"/></marker></defs>${g.relations.map(r=>{const a=positions.get(r.from_id),b=positions.get(r.to_id);return `<line x1="${a.x}" y1="${a.y+12}" x2="${b.x}" y2="${b.y-18}" stroke="currentColor" stroke-width="1" marker-end="url(#arrow)"/>`;}).join('')}${nodes.map(n=>{const p=positions.get(n.id);return `<g><rect x="${p.x-103}" y="${p.y-20}" width="206" height="45" rx="8"/><text x="${p.x}" y="${p.y}" text-anchor="middle">${esc(n.text.slice(0,13))}</text><text class="graph-kind" x="${p.x}" y="${p.y+17}" text-anchor="middle">${esc(graphKind(n.kind))}</text></g>`;}).join('')}</svg>
 <section><h3>項目と原資料</h3>${nodes.map(n=>`<details class="fold"><summary>${esc(n.text)} · ${esc(graphKind(n.kind))}</summary><p>${esc(n.payload.description||n.payload.scope||n.payload.reason||n.payload.conditions?.join('、')||'')}</p><p>${esc(n.source_title||'出典未確認')}${n.page?` · p.${esc(n.page)}`:''}</p><button class="quiet" data-graph-source="${n.capture_id}">原資料を読む</button><button class="quiet" data-graph-focus="${esc(n.id)}" data-cap="${n.capture_id}">この項目の周辺へ</button></details>`).join('')}</section>
 <section><h3>関係の根拠</h3>${g.relations.map(r=>`<details class="fold"><summary>${esc(nodes.find(n=>n.id===r.from_id)?.text)} → ${esc(relationLabel(r.type))} → ${esc(nodes.find(n=>n.id===r.to_id)?.text)}</summary><p>${esc(r.payload.reason)}</p><p class="subtle">条件 ${r.payload.conditions.map(esc).join('、')||'未確認'} · ${esc(({source_explanation:'資料が述べる説明',ai_hypothesis:'AIの仮説',ai_analogy:'AIの類推'})[r.payload.interpretation]||'未確認')}</p>${r.payload.evidence.map(e=>`<blockquote>${esc(e.quote||'AI仮説・引用なし')}<br><button class="quiet" data-graph-source="${esc(e.claim_id.split(':')[0])}">引用元の記録</button></blockquote>`).join('')}</details>`).join('')||'<p>現在の根拠で確認できる関係はありません。</p>'}</section>
 <details class="fold"><summary>高度な整理：概念の統合・分割・再構成</summary><p class="subtle">原資料・安定した参照ID・採用した見方は保持します。AI案を確認してから反映でき、履歴から取り消せます。整理対象は選んだ概念の文脈だけです。</p><form id="concept-form">${nodes.filter(n=>n.kind==='concept').map(n=>`<label><input name="concept-node" type="checkbox" value="${esc(n.id)}"> ${esc(n.text)} · ${esc(n.source_title||'資料')}</label>`).join('')}<label><span>整理方法</span><select id="concept-action"><option value="merge">選んだ概念を統合する</option><option value="split">選んだ文脈だけ別概念にする</option></select></label><label><span>整理したい理由</span><textarea id="concept-reason" maxlength="1000" required></textarea></label><p id="concept-error" class="error"></p><button class="quiet">AIの整理案を見る（AI処理1回）</button></form><button id="concept-history" class="quiet">整理の履歴を読む</button><button id="graph-rebuild" class="quiet">この記録を再構成する（AI処理）</button></details>`);
 document.querySelectorAll('[data-graph-source]').forEach(el=>el.onclick=()=>{closeDialog();openCapture(el.dataset.graphSource).catch(e=>showNotice(e.message));});document.querySelectorAll('[data-graph-focus]').forEach(el=>el.onclick=()=>openNeighborhood(el.dataset.cap,el.dataset.graphFocus));
 bind('#concept-form','submit',async event=>{event.preventDefault();event.submitter.disabled=true;try{const e=await api('/api/concept-edits',json('POST',{action:$('#concept-action').value,reason:$('#concept-reason').value,node_ids:[...event.target.querySelectorAll('input:checked')].map(i=>i.value)}));showConceptEdit(e);}catch(e){$('#concept-error').textContent=e.message;event.submitter.disabled=false;}});
 bind('#concept-history','click',async()=>{try{const edits=await api('/api/concept-edits');modal('概念整理の履歴',edits.map(e=>`<button class="capture-row" data-concept-edit="${e.id}">${esc(e.reason)} · ${esc(e.state)}</button>`).join('')||'<p>整理の履歴はまだありません。</p>');document.querySelectorAll('[data-concept-edit]').forEach(el=>el.onclick=async()=>showConceptEdit(await api(`/api/concept-edits/${el.dataset.conceptEdit}`)));}catch(e){showNotice(e.message);}});
 bind('#graph-rebuild','click',async()=>{try{await api('/api/graph/rebuild',json('POST',{capture_ids:[captureId]}));closeDialog();showNotice('再構成を予約しました。現在の知見は引き続き読めます。');}catch(e){showNotice(e.message);}});
 }catch(e){showNotice(e.message);}
}
function showConceptEdit(e){const p=e.after.proposal;modal('概念の整理案と変更範囲',`<p class="origin">AIの案 · ${esc(e.state)}</p><h3>${esc(p.name)}</h3><p>${esc(p.meaning)}</p><p>${esc(p.reason)}</p>${p.warnings.map(w=>`<p class="subtle">注意：${esc(w)}</p>`).join('')}<p class="subtle">${e.before.length}件の概念参照を${e.action==='merge'?'統合':'独立'}します。引用や関係・見方の本文は変更しません。</p><details class="fold"><summary>対象参照と変更前後</summary>${e.before.map(m=>`<p class="prose">${esc(m.node_id)}<br>${esc(m.concept_id||m.base_concept)} → ${esc(e.after.target)}</p>`).join('')}</details><p id="concept-apply-error" class="error"></p>${e.state==='proposed'?'<button id="concept-apply" class="primary">この整理を反映する</button>':e.state==='applied'?'<button id="concept-undo" class="quiet">この整理を取り消す</button>':'<p>取り消し済みです。</p>'}`);for(const action of ['apply','undo'])bind(`#concept-${action}`,'click',async()=>{try{await api(`/api/concept-edits/${e.id}/${action}`,json('POST',{}));closeDialog();showNotice(action==='apply'?'概念の整理を反映しました。':'概念の整理を取り消しました。');}catch(err){$('#concept-apply-error').textContent=err.message;}});}

async function downloadDevice(){try{const blob=await exportDevice(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='book-harvester-unsent.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(e){showNotice(e.message);}}
function confirmDiscard(operationId){modal('未送信の原資料を削除する',`<p>この端末にしかない原資料や編集を${operationId?'1件':'すべて'}削除します。まだ保存先へ届いていない内容は戻せません。必要なら先に書き出してください。</p><button id="discard-export" class="quiet">未送信の原資料を書き出す</button><p id="discard-error" class="error"></p><button id="discard-confirm" class="primary">端末から削除する</button>`);bind('#discard-export','click',downloadDevice);bind('#discard-confirm','click',async()=>{try{if(operationId)await discardOperation(operationId);else await discardAllOutbox();closeDialog();await home();}catch(e){$('#discard-error').textContent=e.message;}});}
async function devicePendingDialog(){try{const pending=await pendingOperations();modal('端末の保存状況',`<p class="subtle">${navigator.onLine?'接続がある間、自動で送信します。':'接続後、またはアプリを開き直したときに自動で送信します。'}原資料の送信と知見化は別の状態です。</p>${pending.map(o=>{let value;try{value=o.body.kind==='text'?JSON.parse(o.body.text):null;}catch{}return `<details class="fold"><summary>${o.state==='conflict'?'競合・端末の内容を保持':'端末に保存・未送信'} · ${date(o.created_at)}</summary><p>${esc(o.error||'接続後に続行します。')}</p>${value?`<p class="prose">${esc(value.body||value.note||value.corrected_text||value.text||value.url||value.question||'削除の同期待ち')}</p>`:`<p>${o.body.entries.filter(([k,v])=>typeof v!=='string').map(([k,v])=>esc(v.name)).join('、')}</p>`}${o.server?`<p class="origin">保存先の現行版 · 第${o.server.version}版</p><p class="prose">${esc(o.server.body||o.server.note||o.server.corrected_text||o.server.original_text||'')}</p>`:''}${o.state==='conflict'&&o.method==='PATCH'&&o.server?.version?`<button class="quiet" data-resolve="${o.id}">端末の編集を確認して現行版へ反映</button>`:''}<button class="quiet danger" data-discard-operation="${o.id}">この未送信データを削除</button></details>`;}).join('')||'<p>この保存先の未送信データはありません。</p>'}<button id="pending-export" class="quiet">未送信の原資料を書き出す</button>`);bind('#pending-export','click',downloadDevice);document.querySelectorAll('[data-discard-operation]').forEach(el=>el.onclick=()=>confirmDiscard(el.dataset.discardOperation));document.querySelectorAll('[data-resolve]').forEach(el=>el.onclick=()=>{const op=pending.find(o=>o.id===el.dataset.resolve),local=JSON.parse(op.body.text),isView=op.path.includes('/views/');modal('現行版に端末の編集を反映する',`<form id="resolve-form"><p>第${op.server.version}版の本文・メモを確認し、残したい内容を編集してください。保存先がさらに変われば再び競合として保持します。</p><label><span>${isView?'見方の本文':'訂正した本文'}</span><textarea id="resolve-body">${esc(isView?local.body??op.server.body:local.corrected_text??op.server.corrected_text??op.server.original_text)}</textarea></label><label><span>${isView?'変更理由':'自分の一言'}</span><textarea id="resolve-note">${esc(isView?local.reason||'端末の編集を現行版へ反映':local.note??op.server.note)}</textarea></label><p id="resolve-error" class="error"></p><button class="primary">現行版へ反映する</button></form>`);bind('#resolve-form','submit',async event=>{event.preventDefault();try{await resolveConflict(op.id,isView?{body:$('#resolve-body').value,reason:$('#resolve-note').value}:{corrected_text:$('#resolve-body').value,note:$('#resolve-note').value});closeDialog();await home();}catch(e){$('#resolve-error').textContent=e.message;}});});}catch(e){showNotice(e.message);}}
window.addEventListener('device-cache-error',e=>showNotice(e.detail));
window.addEventListener('device-auth-expired',()=>{closeDialog();login();showNotice('未送信の原資料は端末に残っています。もう一度開いて続けてください。');});
window.addEventListener('device-sync',async()=>{if(!state||dialog.open||uploading)return;try{if(!currentCapture&&!currentView){state=await api(searchPath());renderFeed();}else if(currentCapture?.local_only){currentCapture=await api(`/api/captures/${currentCapture.id}`);renderCapture();}}catch(e){if(e.status!==401)showNotice(e.message);}});
initDevice().then(()=>resume()).catch(e=>showNotice(e.message));



function themeHome(index){
 if(!index)return '';
 const themes=index.themes||[],domains=index.domains||[];
 return `<section class="theme-home" aria-label="育てている問い"><p class="section-label">育てている問い</p>${domains.map(d=>{const list=themes.filter(t=>JSON.parse(t.domain_ids||'[]').includes(d.id));return `<section class="theme-domain"><h2>${esc(d.name)}</h2>${list.map(t=>{const r=t.result?JSON.parse(t.result):null;return `<button class="capture-row theme-row" data-theme="${esc(t.id)}"><h3>${esc(t.question)}</h3><p>${esc(t.stale?'根拠が変わっています。更新前の理解です。':r?.understanding[0]?.text||(t.material_count?'材料が集まっています。テーマを開いて理解を更新できます。':'これから材料を集める問いです。'))}</p>${!t.stale&&r?.changed&&r?.change_reason?`<p class="subtle">今回の変化 · ${esc(r.change_reason)}</p>`:''}${['failed','blocked'].includes(t.job_state)?'<p class="subtle">整理は保留中です。保存した材料と以前の理解は読めます。</p>':''}</button>`;}).join('')}</section>`;}).join('')}</section>`;
}
function wireThemeLinks(){document.querySelectorAll('[data-theme]').forEach(el=>el.onclick=event=>{event.preventDefault();openTheme(el.dataset.theme).catch(e=>showNotice(e.message));});}
async function openTheme(themeId,fromCapture=null){
 const t=await api(`/api/themes/${encodeURIComponent(themeId)}`);if(t.redirect)return openTheme(t.redirect,fromCapture);
 currentCapture=null;currentView={id:themeId,theme:true,revision:t.revision,job_state:t.job?.state};
 const r=t.result;
 const sections=[['understanding','現在の暫定理解'],['changes','最近起きている変化'],['competing','競合する説明'],['conditions','成立条件と反例'],['questions','次に確かめたい問い']];
 const proof=e=>{const p=t.evidence.find(p=>p.claim_id===e.claim_id);return p?`<blockquote>${esc(p.quote||'AIの推論・原文引用なし')}<p class="subtle">${esc(({source:'資料の主張',user:'本人の発言',ai:'AIの推論'})[p.origin])} · ${esc(p.source_title||'出典未確認')}${p.page?` · p.${esc(p.page)}`:''} · ${esc(({support:'説明の支持',counterexample:'反例',condition:'条件追加',example:'具体例',background:'背景',unresolved:'未解決'})[e.role])}</p><a href="#" data-theme-source="${esc(p.capture_id)}">原記録を読む</a></blockquote>`:'';};
 app.innerHTML=`${header()}<nav class="theme-nav"><button id="back" class="back">← 育てている問い</button>${fromCapture?'<button id="theme-origin-back" class="back">← 元の記録</button>':''}</nav><article><div class="detail-head"><p class="eyebrow">AIが整理した理解${t.revision?` · 第${t.revision}版`:''}</p><h1>${esc(t.theme.question)}</h1><p class="subtle">${esc(t.theme.scope)}</p>${t.stale?'<p class="status">原根拠が変更・削除されています。以下は更新前の理解です。有効な引用だけを表示しています。</p>':''}${t.job&&['failed','blocked'].includes(t.job.state)?`<p class="subtle">${esc(errors[t.job.error_code]||'整理を完了できませんでした。原資料と以前の理解は保存されています。')}</p>`:''}</div>
 ${r?sections.map(([key,label])=>r[key].length?`<section class="detail-section"><h2>${label}</h2>${r[key].map(e=>`<p class="prose">${esc(e.text)}</p><p class="subtle">${e.interpretation==='ai'?'AIの仮説・整理':e.interpretation==='user'?'本人の発言':'資料が述べる説明'}${e.period?` · 対象時期 ${esc(e.period)}`:''}</p><details class="fold"><summary>根拠を読む</summary>${e.evidence.map(proof).join('')||'<p>現時点で有効な原根拠を確認できません。</p>'}</details>`).join('')}</section>`:'').join(''):'<section class="detail-section"><p>まだ統合知見はありません。記録から「関連を探す」で材料を選べます。</p></section>'}
 ${r?.changed&&r?.change_reason?`<section class="detail-section"><h2>今回の理解の変化</h2><p>${esc(r.change_reason)}</p></section>`:''}
 ${t.history.length?`<details class="fold"><summary>理解が変わった理由</summary>${t.history.map(h=>`<p>第${h.version}版 · ${date(h.created_at)}<br>${esc(h.change_reason)}</p>`).join('')}</details>`:''}
 ${t.relations.length?`<section class="detail-section"><h2>ほかの問いとのつながり</h2>${t.relations.map(x=>{const p=JSON.parse(x.payload);return `<p>${esc(p.common_structure)}</p><p class="subtle">違い：${esc(p.important_difference)}</p><a href="#" data-theme="${esc(x.to_theme)}">つながるテーマを読む</a>`;}).join('')}</section>`:''}
 ${t.proposals.length?`<details class="fold"><summary>自分の見方への案</summary><p class="subtle">採用したときだけ、自分の見方に保存します。</p>${t.proposals.map(p=>`<p class="prose">${esc(p.to_text)}</p><p>${esc(p.reason)}</p><button class="quiet" data-theme-adopt="${p.id}">この見方を採用する</button><button class="quiet" data-theme-hide="${p.id}">この案を表示しない</button>`).join('')}</details>`:''}
 ${t.views.length?`<section class="detail-section"><h2>自分が採用した見方</h2>${t.views.map(v=>`<a href="#" data-theme-view="${v.id}">${esc(v.body)}</a>`).join('<br>')}</section>`:''}
 <button id="theme-rebuild" class="quiet">理解を更新する</button><details class="fold"><summary>この問いに集まった記録</summary>${t.materials.map(m=>`<p>${esc(m.reason)}<br><a href="#" data-theme-source="${m.capture_id}">原記録を読む</a></p>`).join('')||'<p>まだ関連する記録はありません。</p>'}</details></article>`;
 bind('#theme-rebuild','click',async event=>{event.target.disabled=true;try{await api(`/api/themes/${encodeURIComponent(themeId)}/rebuild`,json('POST',{version:t.theme.version,idempotency_key:crypto.randomUUID()}));await openTheme(themeId);showNotice('理解の更新を予約しました。');}catch(e){showNotice(e.message);event.target.disabled=false;}});
 wireHeader();wireThemeLinks();bind('#back','click',()=>home().catch(e=>showNotice(e.message)));bind('#theme-origin-back','click',()=>openCapture(fromCapture));
 document.querySelectorAll('[data-theme-source]').forEach(el=>el.onclick=async event=>{event.preventDefault();await openCapture(el.dataset.themeSource);const parent=document.createElement('button');parent.className='back';parent.textContent='← この根拠を使うテーマ';parent.onclick=()=>openTheme(themeId,currentCapture?.id);$('#back').after(parent);});
 document.querySelectorAll('[data-theme-view]').forEach(el=>el.onclick=event=>{event.preventDefault();openView(el.dataset.themeView).catch(e=>showNotice(e.message));});
 for(const action of ['adopt','hide'])document.querySelectorAll(`[data-theme-${action}]`).forEach(el=>el.onclick=async()=>{el.disabled=true;try{await api(`/api/themes/${encodeURIComponent(themeId)}/proposals`,json('POST',{action,proposal_id:el.dataset[action==='adopt'?'themeAdopt':'themeHide']}));await openTheme(themeId);}catch(e){showNotice(e.message);el.disabled=false;}});
}

function showRelated(run,c){
 const target=$('#related-candidates');if(!target)return;const find=$('#find-related');if(find)find.className='quiet';
 if(run.state!=='completed'){target.innerHTML='<p class="subtle">探索中、または中断しています。</p>';return;}
 const labels={common:'共通',support:'補強',counterexample:'反例',condition:'条件',analogy:'別分野の共通構造',question:'問い'};
 const storageKey=`related:${run.id}`;let selected;try{selected=JSON.parse(sessionStorage.getItem(storageKey));}catch{}if(!Array.isArray(selected))selected=run.candidates.map(x=>x.id);
 target.innerHTML=`${run.candidates.length?run.candidates.map(x=>`<label><input type="checkbox" data-related-select="${esc(x.id)}" ${selected.includes(x.id)?'checked':''}> ${esc(x.title)}<br><span class="subtle">${labels[x.relation]} · ${esc(x.reason)}</span></label><details class="fold"><summary>原資料を読む</summary><p class="prose">${esc(x.text)}</p><a href="#" data-related-open="${esc(x.id)}">記録を開く</a></details>`).join(''):'<p class="subtle">有用な関連は見つかりませんでした。</p>'}<p class="subtle">${esc(run.destination.question)}</p>${run.retained_evidence?.length?`<details class="fold"><summary>引き継ぐ既存根拠（${run.retained_evidence.length}件）</summary>${run.retained_evidence.map(e=>`<p>${esc(e.title)}</p>`).join('')}</details>`:''}<button id="integrate-related" class="primary"></button>`;
 const ids=()=>[...target.querySelectorAll('[data-related-select]:checked')].map(x=>x.dataset.relatedSelect);
 const update=()=>{sessionStorage.setItem(storageKey,JSON.stringify(ids()));$('#integrate-related').textContent=`${1+ids().length}件を統合する`;};target.querySelectorAll('[data-related-select]').forEach(x=>x.addEventListener('change',update));update();target.querySelectorAll('[data-related-open]').forEach(x=>x.addEventListener('click',e=>{e.preventDefault();openCapture(x.dataset.relatedOpen);}));
 bind('#integrate-related','click',async event=>{event.target.disabled=true;const selectedIds=ids();const actionKey=`integration:${run.id}:${selectedIds.slice().sort().join(',')}`;let key=sessionStorage.getItem(actionKey);if(!key){key=crypto.randomUUID();sessionStorage.setItem(actionKey,key);}try{const r=await api('/api/book/integrate',json('POST',{discovery_id:run.id,selected_ids:selectedIds,idempotency_key:key}));if(r.state==='completed')await openTheme(r.theme_id);else showNotice('処理中、または中断しています。');}catch(e){showNotice(e.message);}finally{event.target.disabled=false;}});
}
