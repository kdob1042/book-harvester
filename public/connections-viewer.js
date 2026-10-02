import { CARD, buildConnections, visibleConnections, layoutConnections, labelLines } from './connections-model.js';

const NS = 'http://www.w3.org/2000/svg';
const element = (tag, className, text) => {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
};
const svgElement = (tag, attrs = {}, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text; return node;
};
const button = (text, label, action, className = 'cv-button') => {
  const node = element('button', className, text); node.type = 'button';
  node.setAttribute('aria-label', label); node.title = label; node.addEventListener('click', action); return node;
};
const array = value => Array.isArray(value) ? value : [];
let active = null;

// Request allowlist and GET-only semantics are deliberate. Opening, searching,
// expanding and revisiting this viewer must not schedule an AI job or mutate data.
export async function readConnectionData(path, signal, fetcher = fetch) {
  if (!/^\/api\/(themes(?:\/[^/?#]+)?|captures\/[a-f0-9-]{36})$/.test(path)) throw new Error('表示対象を確認してください。');
  let response;
  try {
    response = await fetcher(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('読み込めませんでした。接続を確認して再試行してください。');
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error('ログインを確認してください。'); error.auth = true; throw error;
  }
  if (response.status === 404) { const error = new Error('この項目は削除されたか、表示できなくなりました。'); error.missing = true; throw error; }
  if (!response.ok) throw new Error('読み込めませんでした。接続を確認して再試行してください。');
  if (!response.headers.get('content-type')?.includes('application/json')) {
    const error = new Error('ログインを確認してください。'); error.auth = true; throw error;
  }
  return response.json();
}

export function openConnections(opener = document.activeElement) {
  if (active?.open) { active.querySelector('input')?.focus(); return active; }
  const controller = new AbortController();
  const dialog = element('dialog', 'connections-viewer'); active = dialog;
  dialog.setAttribute('aria-labelledby', 'connections-title');
  const header = element('header', 'cv-header'), title = element('h2', '', 'つながり'); title.id = 'connections-title';
  const search = element('input', 'cv-search'); search.type = 'search'; search.placeholder = '問い・記録を探す';
  search.setAttribute('aria-label', '表示中の問い・記録を検索'); search.maxLength = 200;
  header.append(title, search, button('×', 'つながりを閉じる', () => dialog.close()));
  const body = element('div', 'cv-body'), canvas = element('section', 'cv-canvas');
  const svg = svgElement('svg', { class: 'cv-graph', role: 'group', tabindex: '0',
    'aria-label': 'つながり図。ドラッグで移動、プラスとマイナスで拡大縮小。項目はEnterで選択できます。' });
  const controls = element('div', 'cv-controls');
  const status = element('p', 'cv-status', '読み込み中…'); status.setAttribute('role', 'status');
  const legend = element('p', 'cv-legend');
  legend.append(element('span', 'cv-solid', '親子・統合'), element('span', 'cv-dashed', '材料'));
  const message = element('div', 'cv-message');
  const panel = element('aside', 'cv-detail'); panel.hidden = true; panel.setAttribute('aria-label', '選択した項目');
  canvas.append(svg, controls, message, legend, status); body.append(canvas, panel); dialog.append(header, body);
  document.body.append(dialog); document.body.classList.add('connections-open'); dialog.showModal(); search.focus();

  let index = { themes: [], branches: [] }, graph, shown, layout, selection = null, requestNumber = 0, isClosed = false;
  const details = new Map(), captures = new Map(), requests = new Map();
  let box = { x: 0, y: 0, w: 1000, h: 600 }, wasFit = true, searchTimer;
  const history = [];
  const back = button('戻る', '前の項目に戻る', async () => {
    const previous = history.pop(); if (!previous) return;
    search.value = previous.search;
    await select(previous.id, false);
    if (isClosed || selection !== previous.id) return;
    setBox(previous.box); wasFit = previous.wasFit;
    back.disabled = history.length === 0;
  });
  back.disabled = true;
  function setBox(next) {
    if (![next.x, next.y, next.w, next.h].every(Number.isFinite) || next.w <= 0 || next.h <= 0) return;
    box = next; svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  }
  function fit() {
    if (!layout) return;
    const rect = svg.getBoundingClientRect(), ratio = Math.max(1, rect.width) / Math.max(1, rect.height);
    const w = Math.max(layout.width + 96, (layout.height + 96) * ratio);
    setBox({ x: (layout.width - w) / 2, y: (layout.height - w / ratio) / 2, w, h: w / ratio }); wasFit = true;
  }
  function zoom(factor, clientX, clientY) {
    const rect = svg.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const px = clientX === undefined ? 0.5 : (clientX - rect.left) / rect.width;
    const py = clientY === undefined ? 0.5 : (clientY - rect.top) / rect.height;
    const w = Math.min(Math.max(box.w / factor, rect.width * 0.3), Math.max(rect.width * 8, layout?.width * 2 || 0));
    const scale = w / box.w;
    setBox({ x: box.x + box.w * px * (1 - scale), y: box.y + box.h * py * (1 - scale), w, h: box.h * scale });
    wasFit = false;
  }
  function pan(dx, dy) {
    const rect = svg.getBoundingClientRect();
    setBox({ ...box, x: box.x - dx * box.w / Math.max(1, rect.width), y: box.y - dy * box.h / Math.max(1, rect.height) }); wasFit = false;
  }
  controls.append(back, button('+', '拡大', () => zoom(1.3)), button('−', '縮小', () => zoom(1 / 1.3)), button('全体', '全体を表示', fit));

  function draw(reset = false) {
    const previous = selection && layout?.positions.get(selection);
    graph = buildConnections(index, details, captures);
    shown = visibleConnections(graph, search.value, selection); layout = layoutConnections(shown);
    const focusedId = document.activeElement?.closest?.('[data-cv-node]')?.dataset.cvNode;
    svg.replaceChildren();
    for (const edge of shown.edges) {
      const a = layout.positions.get(edge.from), b = layout.positions.get(edge.to);
      if (!a || !b) continue;
      const x1 = a.x + CARD.width / 2, y1 = a.y + CARD.height, x2 = b.x + CARD.width / 2, y2 = b.y;
      const selectedEdge = edge.from === selection || edge.to === selection;
      const opposing=edge.kind==='opposes';
      const horizontal=opposing?`M ${a.x+CARD.width} ${a.y+CARD.height/2} L ${b.x} ${b.y+CARD.height/2}`:null;
      const path = svgElement('path', { d: horizontal || `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`,
        class: `cv-edge cv-edge-${edge.kind}${selectedEdge ? ' cv-edge-selected' : ''}${edge.stale ? ' cv-edge-stale' : ''}` });
      path.append(svgElement('title', {}, ({ opposes: '対立する仮説', input: '保存された統合元', drilldown: '掘り下げた子問い', hierarchy: '保存された親子関係', material: '問いに集まった材料' })[edge.kind]));
      svg.append(path);
    }
    for (const node of shown.nodes) {
      const p = layout.positions.get(node.id), selected = node.id === selection;
      const group = svgElement('g', { transform: `translate(${p.x},${p.y})`, role: 'button', tabindex: '0',
        'data-cv-node': node.id, 'aria-label': `${node.kind === 'theme' ? '問い' : '記録'}：${node.title}`,
        'aria-pressed': selected ? 'true' : 'false',
        class: `cv-node cv-node-${node.kind}${node.count ? ' cv-node-integrated' : ''}${selected ? ' cv-node-selected' : ''}` });
      group.append(svgElement('title', {}, node.title), svgElement('rect', { width: CARD.width, height: CARD.height, rx: node.kind === 'capture' ? 6 : 15 }));
      group.append(svgElement('text', { x: 14, y: 21, class: 'cv-node-kind' },
        node.kind === 'capture' ? '記録' : '問い'));
      labelLines(node.title).forEach((text, i) => group.append(svgElement('text', { x: 14, y: 44 + i * 20, class: 'cv-node-title' }, text)));
      if (node.stale) group.append(svgElement('text', { x: CARD.width - 22, y: 21, class: 'cv-node-stale' }, '!'));
      group.addEventListener('click', event => { if (!suppressClick || event.detail === 0) select(node.id); });
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(node.id); }
      });
      svg.append(group);
    }
    status.textContent = shown.truncated ? `${shown.nodes.length} / ${shown.eligible}件 · 検索で絞り込めます` : `${shown.nodes.length}件`;
    if (layout.cyclic.size) status.textContent += ' · 循環する関係があります';
    message.replaceChildren();
    if (!shown.nodes.length) message.append(element('p', '', graph.nodes.length ? '見つかりませんでした。' : '問いはまだありません。'));
    if (reset || wasFit) fit();
    else if (previous && layout.positions.has(selection)) {
      const current = layout.positions.get(selection);
      setBox({ ...box, x: box.x + current.x - previous.x, y: box.y + current.y - previous.y });
    }
    if (focusedId) [...svg.querySelectorAll('[data-cv-node]')].find(el => el.dataset.cvNode === focusedId)?.focus({ preventScroll: true });
  }

  function section(titleText, paragraphs) {
    const s = element('section', 'cv-section'); s.append(element('h3', '', titleText));
    for (const text of paragraphs.filter(Boolean)) s.append(element('p', 'cv-prose', text));
    return s;
  }
  function panelHeading(node) {
    panel.replaceChildren(); panel.hidden = false;
    const h = element('div', 'cv-detail-head');
    h.append(element('h3', '', node.title), button('×', '選択を解除', () => { selection = null; requestNumber++; panel.hidden = true; draw(); }));
    panel.append(h);
  }
  function connectionsList(node) {
    const rows = graph.edges.filter(edge => edge.from === node.id || edge.to === node.id);
    if (!rows.length) return;
    const block = element('section', 'cv-section'); block.append(element('h3', '', 'つながり'));
    for (const edge of rows) {
      const other = graph.nodes.find(n => n.id === (edge.from === node.id ? edge.to : edge.from));
      if (!other) continue;
      const labels = { opposes: ['対立', '対立'], input: ['統合元', '統合先'], drilldown: ['掘り下げた問い', '元の問い'], hierarchy: ['子の問い', '親の問い'], material: ['材料', '問い'] };
      const label = labels[edge.kind][edge.from === node.id ? 0 : 1];
      const row = button('', `${label}：${other.title}`, () => select(other.id), 'cv-connection');
      row.append(element('span', 'cv-connection-kind', label), element('span', '', other.title));
      if (edge.reason) row.append(element('span', 'cv-connection-reason', edge.reason));
      block.append(row);
    }
    panel.append(block);
  }
  function showDetail(node, data) {
    panelHeading(node);
    if (node.kind === 'theme') {
      if (data.theme.content) panel.append(section('内容', [data.theme.content]));
      if (data.stale) panel.append(element('p', 'cv-warning', '根拠に更新があります。以下は保存時の知見です。'));
      const understanding = array(data.result?.understanding).map(item => item.text);
      if (understanding.length) panel.append(section('知見', understanding));
      if (array(data.result?.conditions).length || array(data.result?.competing).length) {
        const fold = element('details', 'cv-fold'); fold.append(element('summary', '', '条件・反例'));
        fold.append(section('条件', array(data.result.conditions).map(item => item.text)),
          section('反例', array(data.result?.competing).map(item => item.text))); panel.append(fold);
      }
      if (array(data.materials).length >= 100) panel.append(element('p', 'cv-warning', '材料は新しい100件まで表示しています。'));
    } else {
      const source = [data.source_title, data.page ? `p.${data.page}` : null].filter(Boolean).join(' · ');
      if (source) panel.append(element('p', 'cv-meta', source));
      if (data.harvest?.summary) panel.append(section('知見', [data.harvest.summary]));
      const claims = array(data.harvest?.claims);
      if (claims.length) {
        const fold = element('details', 'cv-fold'); fold.append(element('summary', '', `気づき ${claims.length}`));
        for (const claim of claims) {
          const item = section('', [claim.text]);
          if (claim.evidence?.quote) item.append(element('blockquote', 'cv-prose', claim.evidence.quote));
          fold.append(item);
        }
        panel.append(fold);
      }
      const original = data.original_text || data.harvest?.extracted_text;
      if (original) {
        const fold = element('details', 'cv-fold');
        fold.append(element('summary', '', data.original_text ? '原文' : '読み取り本文'), element('p', 'cv-prose', original)); panel.append(fold);
      }
      if (data.corrected_text && data.corrected_text !== original) {
        const fold = element('details', 'cv-fold'); fold.append(element('summary', '', '訂正後の本文'), element('p', 'cv-prose', data.corrected_text)); panel.append(fold);
      }
      if (data.note) panel.append(section('メモ', [data.note]));
      for (const asset of array(data.assets)) {
        if (!/^[a-f0-9-]{36}$/.test(asset.id)) continue;
        const link = element('a', 'cv-asset', asset.name || '元ファイル');
        link.href = `/api/assets/${asset.id}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; panel.append(link);
      }
    }
    connectionsList(node);
  }
  function showError(target, error, retry) {
    target.replaceChildren(element('p', 'cv-error', error.message || '読み込めませんでした。'));
    target.append(button(error.auth ? 'ログインを確認' : '再試行', error.auth ? 'ページを開き直す' : '再試行',
      error.auth ? () => location.reload() : retry));
  }
  async function get(path) {
    if (!requests.has(path)) {
      const request = readConnectionData(path, controller.signal);
      requests.set(path, request); request.catch(() => requests.delete(path));
    }
    return requests.get(path);
  }
  async function select(id, remember = true) {
    const node = graph.nodes.find(n => n.id === id); if (!node) return;
    if (remember && selection && selection !== id) {
      history.push({ id: selection, box: { ...box }, wasFit, search: search.value });
      if (history.length > 100) history.shift();
      back.disabled = false;
    }
    const serial = ++requestNumber; selection = id; draw(); panelHeading(node);
    panel.append(element('p', 'cv-meta', '読み込み中…'));
    try {
      const data = node.kind === 'theme'
        ? await get(`/api/themes/${encodeURIComponent(node.entityId)}`)
        : await get(`/api/captures/${encodeURIComponent(node.entityId)}`);
      if (isClosed || serial !== requestNumber) return;
      if (data.redirect) {
        panelHeading(node); panel.append(element('p', 'cv-meta', '問いの統合先が変わりました。全体を更新してください。'));
        panel.append(button('更新', 'つながりを更新', () => load())); return;
      }
      if (node.kind === 'theme') details.set(node.entityId, data); else captures.set(node.entityId, data);
      draw(); showDetail(graph.nodes.find(n => n.id === id) || node, data);
      if (node.kind === 'capture' && Number(data.version) !== node.version) {
        panel.prepend(element('p', 'cv-warning', '記録が更新されています。以前の版への線は表示していません。'));
      }
    } catch (error) {
      if (isClosed || serial !== requestNumber || error.name === 'AbortError') return;
      if (error.missing && node.kind === 'capture') { captures.set(node.entityId, { unavailable: true }); draw(); }
      showError(panel, error, error.missing ? load : () => select(id));
    }
  }
  async function load() {
    const serial = ++requestNumber;
    selection = null; history.length = 0; back.disabled = true; details.clear(); captures.clear(); requests.clear();
    index = { themes: [], branches: [] }; svg.replaceChildren(); layout = null; search.disabled = true;
    panel.hidden = true; message.replaceChildren(); status.textContent = '読み込み中…';
    try {
      const result = await get('/api/themes'); if (isClosed || serial !== requestNumber) return;
      if (!Array.isArray(result?.themes) || !Array.isArray(result?.branches)) throw new Error('つながりの形式を確認できませんでした。');
      index = result; search.disabled = false; draw(true);
    } catch (error) { if (!isClosed && serial === requestNumber && error.name !== 'AbortError') { status.textContent = ''; showError(message, error, load); } }
  }
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => draw(true), 120); });
  svg.addEventListener('wheel', event => { event.preventDefault(); zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * 0.003), event.clientX, event.clientY); }, { passive: false });
  svg.addEventListener('keydown', event => {
    if (['+', '=', '-', '0', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.preventDefault();
    if (event.key === '+' || event.key === '=') zoom(1.3); else if (event.key === '-') zoom(1 / 1.3);
    else if (event.key === '0') fit(); else if (event.key === 'ArrowUp') pan(0, 60);
    else if (event.key === 'ArrowDown') pan(0, -60); else if (event.key === 'ArrowLeft') pan(60, 0);
    else if (event.key === 'ArrowRight') pan(-60, 0);
  });
  const pointers = new Map(); let suppressClick = false;
  const pair = () => {
    const p = [...pointers.values()]; if (p.length < 2) return null;
    return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, distance: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
  };
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (!pointers.size) suppressClick = false;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    // Capture on the original target so a tap still dispatches its click to the node.
    event.target.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId); if (!previous) return;
    const before = pair();
    pointers.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY }); const after = pair();
    if (Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY) > 5) suppressClick = true;
    if (before && after && before.distance > 0 && after.distance > 0) {
      suppressClick = true; zoom(after.distance / before.distance, before.x, before.y); pan(after.x - before.x, after.y - before.y);
    } else if (suppressClick) pan(event.clientX - previous.x, event.clientY - previous.y);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) svg.addEventListener(name, event => pointers.delete(event.pointerId));
  const resize = new ResizeObserver(() => {
    if (isClosed || !layout) return;
    if (wasFit) fit();
    else {
      const rect = svg.getBoundingClientRect(), h = box.w * rect.height / Math.max(1, rect.width);
      setBox({ ...box, y: box.y + (box.h - h) / 2, h });
    }
  }); resize.observe(svg);
  dialog.addEventListener('close', () => {
    isClosed = true; controller.abort(); clearTimeout(searchTimer); resize.disconnect();
    requests.clear(); details.clear(); captures.clear(); document.body.classList.remove('connections-open'); dialog.remove();
    if (active === dialog) active = null; if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, { once: true });
  load(); return dialog;
}
