const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const date = value => new Intl.DateTimeFormat('ja-JP', { month:'short', day:'numeric', timeZone:'Asia/Tokyo' }).format(new Date(value));
const $ = selector => document.querySelector(selector);
let state, currentCapture = null, currentView = null, query = '', recorder = null, stream = null, uploading = false, uploadPending = null;
let noticeTimer, searchTimer, pollBusy = false;
const errors = {
  ai_not_configured:'原資料は保存済みです。AI設定後に自動で読み取ります。',
  daily_limit:'原資料は保存済みです。今日の解析上限に達しました。明日、自動で続けます。',
  invalid_output:'読み取り結果を確認できませんでした。原資料は残っています。',
  empty_transcript:'音声を読み取れませんでした。原音声は残っています。',
  refused:'この資料は解析できませんでした。原資料は残っています。',
  incomplete_output:'解析結果が途中で止まりました。原資料は残っています。',
  provider_rejected:'解析の設定を確認する必要があります。原資料は残っています。',
};
const statusLabel = c => ({ completed:'', pending:'読み取り待ち', running:'読み取り中', failed:'読み取りできませんでした', blocked:c.error_code === 'daily_limit' ? '明日読み取り' : '保存済み・AI設定待ち', superseded:'新しい版を読み取り中' })[c.state || c.job?.state] || '';
const bind = (selector, event, fn) => $(selector)?.addEventListener(event, fn);

function showNotice(text) {
  clearTimeout(noticeTimer); notice.textContent = text;
  noticeTimer = setTimeout(() => { notice.textContent = ''; }, 4500);
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials:'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '通信を確認して、もう一度お試しください。');
    error.status = response.status;
    if (response.status === 401 && path !== '/api/login') { closeDialog(); login(); }
    throw error;
  }
  return data;
}
const json = (method, data) => ({ method, headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });

function login() {
  currentCapture = null; currentView = null; state = null;
  app.innerHTML = `<div class="login"><p class="eyebrow">BOOK HARVESTER</p><h1>読書の続きを、ここから。</h1>
    <form id="login-form"><label><span>パスワード</span><input id="password" type="password" required autocomplete="current-password"></label>
    <p id="login-error" class="error" role="alert"></p><button class="primary" type="submit">開く</button></form></div>`;
  app.removeAttribute('aria-busy');
  bind('#login-form', 'submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await api('/api/login', json('POST', { password:$('#password').value })); await home(); }
    catch (error) { $('#login-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
}

function header(record = true) {
  return `<header class="top"><div class="brand"><img src="/favicon.svg" alt="">Book Harvester</div><div class="top-actions">
    ${record ? '<button id="record" class="primary">記録する<span aria-hidden="true">＋</span></button>' : ''}
    <details class="menu"><summary aria-label="メニュー">···</summary><div class="menu-panel">
    <label><span>記録を検索</span><input id="search" type="search" placeholder="曖昧な言葉でも" value="${esc(query)}"></label>
    <button id="privacy">AIと保存について</button><a href="/api/export" download>すべて書き出す</a>
    <button id="logout">閉じる</button></div></details></div></header>`;
}
function wireHeader() {
  bind('#record', 'click', () => recordDialog());
  bind('#search', 'input', event => {
    query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try { state = await api(`/api/state?q=${encodeURIComponent(query)}`); renderFeed(); }
      catch (error) { showNotice(error.message); }
    }, 300);
  });
  bind('#privacy', 'click', privacyDialog);
  bind('#logout', 'click', async () => { try { await api('/api/logout', json('POST', {})); login(); } catch (e) { showNotice(e.message); } });
}

async function home() {
  const next = await api(`/api/state?q=${encodeURIComponent(query)}`);
  state = next; currentCapture = null; currentView = null;
  app.innerHTML = `${header()}<section class="intro"><p class="eyebrow">READ · LEAVE · THINK</p>
    <h1>本から拾ったもの。</h1><p>${state.current_source ? `${esc(state.current_source.title)}<br>前回の本を引き継ぎます。表紙を残すと、本も切り替わります。` : '気になったページを、一枚。<br>整理はあとから、自然に。'}</p></section><section id="feed"></section>`;
  app.removeAttribute('aria-busy'); wireHeader(); renderFeed();
}
function renderFeed() {
  if (!$('#feed')) return;
  const captures = state.captures;
  $('#feed').innerHTML = `${captures.length ? '<p class="section-label">読書からの知見</p>' : ''}${captures.map(c => {
    const summary = c.harvest?.summary || c.original_preview || (c.kind === 'image' ? '残したページ' : '残した音声');
    const label = statusLabel(c);
    const locator = c.page ? ` · ${c.locator_certainty === 'inferred' ? '推定 ' : ''}p.${esc(c.page)}` : '';
    return `<button class="capture-row" data-capture="${c.id}"><span class="row-meta"><span>${c.source_certainty === 'inferred' ? '推定 ' : ''}${esc(c.source_title || '出典未確認')}${c.source_inherited ? '（前回の本）' : ''}${locator}</span><span>${date(c.created_at)}</span></span>
      <h2>${esc(summary)}</h2>${label ? `<span class="status ${esc(c.state)}">${esc(label)}</span>` : `<p class="question-preview">${esc(c.harvest?.questions[0]?.text || '原資料と、考えの続きを読む。')}</p>`}</button>`;
  }).join('')}${!captures.length ? `<div class="empty"><img class="empty-symbol" src="/favicon.svg" alt=""><h2>${query ? 'その言葉は、まだ見つかりません。' : '最初の一枚から、育っていきます。'}</h2><p>${query ? '別の言葉で探してみてください。' : '書名も、ページ番号も、タグも不要です。<br>写真を残したら、本の続きへ。'}</p></div>` : ''}
    ${state.views.length && !query ? `<p class="section-label">自分の見方</p>${state.views.map(v => `<button class="view-row" data-view="${v.id}"><span class="row-meta">自分の見方 · 第${v.version}版</span><h2>${esc(v.body)}</h2></button>`).join('')}` : ''}`;
  document.querySelectorAll('[data-capture]').forEach(el => el.addEventListener('click', () => openCapture(el.dataset.capture).catch(e => showNotice(e.message))));
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => openView(el.dataset.view).catch(e => showNotice(e.message))));
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

function getMode() { try { return localStorage.getItem('capture-mode') || 'image'; } catch { return 'image'; } }
function setMode(mode) { try { localStorage.setItem('capture-mode', mode); } catch { /* device preferences are optional */ } }

function recordDialog(target = null) {
  uploadPending = null;
  const mode = ['image','audio','text'].includes(getMode()) ? getMode() : 'image';
  modal(target ? 'この記録に補足する' : '引っかかりを残す', `<label><span>残し方</span><select id="capture-mode" class="capture-mode">
    <option value="image">写真</option><option value="audio">音声</option>${target ? '' : '<option value="text">文章</option>'}</select></label>
    <div id="capture-body" class="capture-body"></div><p id="capture-error" class="error" role="alert"></p>
    <p class="subtle">${target ? 'いま開いている記録に追加します。' : '保存したら、そのまま読書へ。読み取りは続きます。'}</p>`);
  $('#capture-mode').value = target && mode === 'text' ? 'image' : mode;
  const render = () => {
    stopRecorder(); setMode($('#capture-mode').value);
    const selected = $('#capture-mode').value;
    $('#capture-error').textContent = '';
    if (selected === 'image') {
      $('#capture-body').innerHTML = `<input id="image-file" type="file" accept="image/jpeg,image/png,image/webp"><button id="pick-image" class="primary">ページを撮る・選ぶ</button><p>表紙や扉の写真から、本も読み取ります。<br>JPEG・PNG・WebP、10MBまで。</p>`;
      bind('#pick-image', 'click', () => $('#image-file').click());
      bind('#image-file', 'change', event => { if (event.target.files[0]) saveUpload(event.target.files[0], null, target); });
    } else if (selected === 'audio') {
      $('#capture-body').innerHTML = `<button id="record-audio" class="primary">一言、話す</button><p id="record-status">録音を終えると、自動で保存します。</p>
        <details class="fold"><summary>音声ファイルから残す</summary><input id="audio-file" type="file" accept="audio/*,.webm,.m4a"></details>`;
      // A native file picker remains available even if microphone permission is denied.
      bind('#audio-file', 'change', event => { if (event.target.files[0]) saveUpload(event.target.files[0], null, target); });
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
    } else {
      $('#capture-body').innerHTML = `<form id="text-form"><label><span>残したい文章・一言</span><textarea id="capture-text" maxlength="20000" placeholder="引用でも、気づきでも。" required></textarea></label><button class="primary" type="submit">残す</button></form>`;
      bind('#text-form', 'submit', event => { event.preventDefault(); saveUpload(null, $('#capture-text').value, target); });
    }
  };
  bind('#capture-mode', 'change', render); render();
}

async function saveUpload(file, text, target, reuse = null) {
  if (uploading) return;
  if (file?.size > 10 * 1024 * 1024) { $('#capture-error').textContent = 'ファイルは10MB以下にしてください。'; return; }
  uploading = true;
  const pending = reuse || { file, text, target, key:crypto.randomUUID() };
  uploadPending = pending;
  $('#capture-error').textContent = '保存しています。';
  dialog.querySelectorAll('button,input,textarea,select').forEach(el => { el.disabled = true; });
  try {
    const headers = { 'Idempotency-Key':pending.key };
    let payload;
    if (file) { payload = new FormData(); payload.set('file', file); }
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify({ text }); }
    if (target) headers['X-Capture-Version'] = String(target.version);
    await api(target ? `/api/captures/${target.id}/assets` : '/api/captures', { method:'POST', headers, body:payload });
    uploading = false; uploadPending = null; dialog.close();
    if (target) await openCapture(target.id); else await home();
    showNotice('残しました。本の続きへ。');
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

async function openCapture(captureId) {
  currentCapture = await api(`/api/captures/${captureId}`); currentView = null;
  renderCapture();
}
function renderCapture() {
  const c = currentCapture, h = c.harvest, label = statusLabel({ ...c.job, error_code:c.job?.error_code });
  const source = `${c.source_certainty === 'inferred' ? '推定 ' : ''}${esc(c.source_title || '出典未確認')}`;
  const sourceLocator = c.page ? ` · ${c.locator_certainty === 'inferred' ? '推定 ' : ''}p.${esc(c.page)}` : '';
  const adopted = c.views.find(v => v.draft_key === `${c.id}:${c.version}`);
  app.innerHTML = `${header(false)}<button id="back" class="back">← 本から拾ったもの</button>
    <article><div class="detail-head"><p class="eyebrow">${source}${c.source_inherited ? '（前回の本から引き継ぎ）' : ''}${sourceLocator} · ${date(c.created_at)}</p>
    <h1>${esc(h?.summary || '原資料を残しました。')}</h1>${label ? `<p class="status ${esc(c.job?.state)}">${esc(label)}</p>` : ''}
    ${['failed','blocked'].includes(c.job?.state) ? `<p class="subtle">${esc(errors[c.job.error_code] || '原資料は残っています。詳細から再試行できます。')}</p>` : ''}</div>
    ${h ? `<section class="detail-section"><h2>拾った知見</h2>${h.claims.map(claim => `<div class="knowledge-item"><p><span class="origin">${({ source:'資料の主張', user:'自分の発言', ai:'AIの推論' })[claim.evidence.origin]} · ${({ explicit:'根拠あり', inferred:'推論', uncertain:'不確か' })[claim.evidence.certainty]}</span></p>
      <p>${esc(claim.text)}</p>${claim.conditions.length ? `<p class="subtle">条件：${claim.conditions.map(esc).join('、')}</p>` : ''}${claim.evidence.quote ? `<blockquote>${esc(claim.evidence.quote)}</blockquote>` : ''}</div>`).join('')}
      ${h.concepts.length ? `<p class="concepts">${h.concepts.map(k => esc(k.name)).join(' · ')}</p>` : ''}</section>
      ${h.questions.length ? `<section class="detail-section"><h2>考えの続き</h2>${h.questions.map(q => `<p>${esc(q.text)}</p>`).join('')}</section>` : ''}
      ${h.view_draft ? `<section class="draft"><h2>${adopted ? '自分の見方に残しました' : '見方の案 · AIが考えたこと'}</h2><p class="prose">${esc(h.view_draft.text)}</p><p class="subtle">${esc(h.view_draft.reason)}</p>
      ${adopted ? `<a href="#" id="adopted-view">採用した見方と履歴を読む</a>` : '<button id="adopt" class="primary">自分の見方にする</button>'}</section>` : ''}
      ${h.uncertainties.length ? `<p class="subtle">読み取りの留保：${h.uncertainties.map(esc).join(' ／ ')}</p>` : ''}` : ''}
    <details class="fold" id="original"><summary>原資料を読む</summary>
      ${c.assets.map(a => a.mime.startsWith('image/') ? `<img class="source-image" src="/api/assets/${a.id}" alt="保存したページ" loading="lazy">` : `<audio controls preload="none" src="/api/assets/${a.id}"></audio>`).join('')}
      ${c.original_text ? `<h3>最初に残した文章</h3><p class="prose">${esc(c.original_text)}</p>` : ''}
      ${h?.extracted_text ? `<h3>読み取った本文・発話</h3><p class="prose">${esc(h.extracted_text)}</p>` : ''}
      ${c.note ? `<h3>自分の一言</h3><p class="prose">${esc(c.note)}</p>` : ''}
      ${c.source_published_at || c.source_subject_period ? `<p class="subtle">${c.source_published_at ? `公開・発行時期：${esc(c.source_published_at)}` : ''}${c.source_subject_period ? `<br>内容の対象時期：${esc(c.source_subject_period)}` : ''}</p>` : ''}</details>
    <details class="fold"><summary>訂正・補足など</summary><div class="secondary-links"><button id="correct">読み取り・出典を訂正</button><button id="supplement">写真・音声を補足</button>
      ${h ? '<button id="ask">この資料について聞く</button>' : ''}${['failed','blocked'].includes(c.job?.state) ? '<button id="retry">読み取りを再試行</button>' : ''}<button id="delete" class="danger">この記録を削除</button></div></details></article>`;
  wireHeader(); bind('#back', 'click', () => home().catch(e => showNotice(e.message)));
  bind('#adopt', 'click', async event => {
    event.target.disabled = true;
    try { await api(`/api/captures/${c.id}/adopt`, json('POST', { version:c.version })); await openCapture(c.id); showNotice('自分の見方に残しました。'); }
    catch (e) { showNotice(e.message); event.target.disabled = false; }
  });
  bind('#adopted-view', 'click', event => { event.preventDefault(); openView(adopted.id).catch(e => showNotice(e.message)); });
  bind('#correct', 'click', () => correctionDialog(c));
  bind('#supplement', 'click', () => recordDialog(c));
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
  bind('#retry', 'click', async () => {
    try { await api(`/api/captures/${c.id}/retry`, json('POST', { version:c.version })); await openCapture(c.id); }
    catch (e) { showNotice(e.message); }
  });
  bind('#delete', 'click', () => {
    modal('この記録を削除する', '<p>原資料・解析・採用した見方とその履歴を削除します。戻せません。</p><p id="delete-error" class="error" role="alert"></p><button id="confirm-delete" class="primary">削除する</button>');
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
  app.innerHTML = `${header(false)}<button id="back" class="back">← 本から拾ったもの</button><article>
    <div class="detail-head"><p class="eyebrow">自分の見方 · 第${v.version}版</p><h1 class="prose">${esc(v.body)}</h1></div>
    <section class="detail-section"><h2>この見方の根拠</h2><p>${esc(v.revisions[0].references.source_title || '残した資料')}${v.revisions[0].references.page ? ` · p.${esc(v.revisions[0].references.page)}` : ''}</p>
    <a href="#" id="view-source">原資料と解析を読む</a></section>
    <details class="fold"><summary>見方を編集・履歴を読む</summary><button id="edit-view" class="quiet">見方を編集する</button>
    ${v.revisions.map(r => `<div class="history"><p class="subtle">第${r.version}版 · ${date(r.created_at)}</p><p class="prose">${esc(r.body)}</p><p class="subtle">${esc(r.reason)}</p>${r.version !== v.version ? `<button data-restore="${r.version}">この版へ戻す</button>` : ''}</div>`).join('')}</details></article>`;
  wireHeader(); bind('#back','click', () => home().catch(e => showNotice(e.message)));
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

function privacyDialog() {
  modal('AIと保存について', `<div class="privacy"><p>残した写真・音声・文章は、このアプリの非公開データとして保存します。</p>
    <p>解析には、対象の原資料、自分の一言、前回の書名だけをOpenAIへ送ります。過去の読書メモ一式は送りません。通常の記録ごとに確認操作はありません。</p>
    <p>AIが作るのは知見と見方の案です。「自分の見方にする」を選んだ文章だけが、本人の見方として残ります。</p>
    <p class="subtle">${state?.ai_configured ? 'AI解析は設定済みです。' : 'AI解析は未設定です。原資料を保存して待ちます。'}<br>今日の呼び出し ${state?.usage.calls || 0} / ${state?.daily_limit || '—'}（UTC日次）。音声は文字起こしと理解で通常2回。<br>解析は有料APIを使います。上限は呼び出し数で、金額上限ではありません。</p>
    <p class="subtle">削除は記録の詳細から。書き出しには元ファイルと履歴も含みます。</p></div>`);
}

// Poll only small summaries. Never replace an open editor or an expanded source while reading.
setInterval(async () => {
  if (!state || document.hidden || dialog.open || uploading || pollBusy) return;
  pollBusy = true;
  try {
    if (currentCapture && ['pending','running','blocked'].includes(currentCapture.job?.state)) {
      if (!app.querySelector('details[open]')) {
        const fresh = await api(`/api/captures/${currentCapture.id}`);
        if (fresh.job?.state !== currentCapture.job?.state || fresh.version !== currentCapture.version) { currentCapture = fresh; renderCapture(); }
      }
    } else if (!currentCapture && !currentView) {
      state = await api(`/api/state?q=${encodeURIComponent(query)}`); renderFeed();
    }
  } catch (e) { if (e.status !== 401) { /* Preserve the last readable page during a temporary outage. */ } }
  finally { pollBusy = false; }
}, 2500);

home().catch(error => { if (error.status !== 401) { app.innerHTML = '<p class="loading">接続を確認して、ページを開き直してください。</p>'; } });
