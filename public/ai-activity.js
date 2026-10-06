import {isActiveOperation} from './ai-action-contract.js';
// One activity surface for the whole app, independent of page and dialog contents.
export function createAiActivity() {
  const root = document.createElement('aside');
  root.id = 'ai-activity'; root.className = 'ai-dock'; root.hidden = true;
  root.setAttribute('popover', 'manual'); root.setAttribute('aria-label', 'AIの処理状況');
  const tasks = new Map(); let expanded = false, remote = 0, serial = 0;
  const active = task => isActiveOperation(task.state);
  const labels = { running:'中', pending:'待ち', completed:'完了', failed:'失敗', blocked:'待機中', stopping:'停止確認中', unknown:'状態未確認', canceled:'停止済み', offline:'接続待ち', waiting:'範囲選択待ち' };
  const button = (text, action, key) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = text;
    el.dataset.aiFocus = key; el.addEventListener('click', action); return el;
  };
  function mount(parent) {
    // A z-index cannot escape a modal's top layer. A manual popover inside the
    // frontmost dialog remains interactive; moving it back keeps it after close.
    parent ||= [...document.querySelectorAll('dialog[open]')].filter(d => d.matches(':modal')).at(-1) || document.body;
    if (root.parentNode !== parent) {
      if (root.matches(':popover-open')) root.hidePopover();
      parent.append(root);
    }
    if (!root.hidden && root.showPopover && !root.matches(':popover-open')) root.showPopover();
  }
  function render() {
    const focus = root.contains(document.activeElement) ? document.activeElement.dataset.aiFocus : null;
    const visible = [...tasks.values()].filter(t => !t.acknowledged);
    const running = visible.filter(active), count = Math.max(running.length, remote);
    const latest = visible.find(t => (['failed','unknown'].includes(t.state)||t.cancelError)) || visible.at(-1);
    root.hidden = !visible.length && !count;
    if (root.hidden) { expanded = false; if(root.matches(':popover-open')) root.hidePopover(); return; }
    const summary = count > 1 ? `AI処理中 · ${count}件` : running.length ? `${running[0].label}${labels[running[0].state]}` : remote ? 'AI処理中' : `${latest.label}${labels[latest.state] || ''}`;
    const children = [];
    if (expanded) {
      const panel = document.createElement('div'); panel.className = 'ai-dock-panel'; panel.id = 'ai-activity-details';
      const head = document.createElement('div'); head.className = 'ai-dock-head';
      const title = document.createElement('span'); title.textContent = 'AIの処理状況';
      head.append(title, button('閉じる', () => { expanded = false; render(); }, 'collapse')); panel.append(head);
      for (const task of visible) {
        const row = document.createElement('div'); row.className = 'ai-dock-task';
        const name = document.createElement('div'); name.textContent = task.detail || task.label;
        const status = document.createElement('p'); status.className = 'ai-dock-meta';
        status.textContent = task.error || `${task.label}${labels[task.state] || ''}`;
        if ((['failed','unknown'].includes(task.state)||task.cancelError)) status.classList.add('error');
        row.append(name, status);
        const actions = document.createElement('div'); actions.className = 'ai-dock-actions';
        if (task.open) actions.append(button(active(task) ? '対象を開く' : '見る', async () => {
          const wasActive = active(task);
          try { await task.open(task.result); if(!wasActive) task.acknowledged = true; expanded = false; render(); }
          catch(error) { task.error = error.message; render(); }
        }, `open-${task.id}`));
        if (active(task) && task.cancel) {
          const stop=button(task.state==='stopping'?'停止確認中…':task.cancelError?'停止を再試行':'停止', async () => {
            try { await task.cancel(); }
            catch { render(); }
          }, `cancel-${task.id}`);
          stop.disabled=task.state==='stopping';actions.append(stop);
        }
        if (!active(task)) actions.append(button('消す', () => { tasks.delete(task.id); render(); }, `dismiss-${task.id}`));
        row.append(actions); panel.append(row);
      }
      if (remote && !running.length) {
        const text = document.createElement('p'); text.className = 'ai-dock-meta'; text.textContent = 'バックグラウンドでAI処理中'; panel.append(text);
      }
      children.push(panel);
    }
    const trigger = button('', () => { expanded = !expanded; render(); }, 'toggle');
    trigger.className = `ai-dock-trigger${count ? ' is-running' : ''}`;
    trigger.setAttribute('aria-expanded', String(expanded)); trigger.setAttribute('aria-controls', 'ai-activity-details');
    const ring = document.createElement('span'); ring.className = 'ai-dock-ring'; ring.setAttribute('aria-hidden', 'true');
    if (!count) ring.textContent = visible.some(t => (['failed','unknown'].includes(t.state)||t.cancelError)) ? '!' : ['waiting','offline'].includes(latest.state) ? '…' : '✓';
    const text = document.createElement('span'); text.textContent = summary; text.setAttribute('role', 'status'); text.setAttribute('aria-live', 'polite');
    trigger.append(ring, text); children.push(trigger); root.replaceChildren(...children); mount();
    if (focus) [...root.querySelectorAll('[data-ai-focus]')].find(el => el.dataset.aiFocus === focus)?.focus({preventScroll:true});
  }
  function update(id, values) { const task = tasks.get(id); if(task && Object.entries(values).some(([key,value]) => task[key] !== value)) { Object.assign(task, values); render(); } }
  new MutationObserver(() => { if(!root.hidden) mount(); }).observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['open']});
  document.addEventListener('close', () => mount(), true);
  document.body.append(root);
  return {
    start(descriptor) {
      // Keep unresolved work; bound only acknowledged/completed history.
      if(tasks.size >= 20) for(const [id,task] of tasks) if(!active(task)) {tasks.delete(id); break;}
      const id = ++serial; tasks.set(id, {...descriptor, id, state:descriptor.state||'running'}); render(); return id;
    },
    update, mount,
    remove(id) {tasks.delete(id);render();},
    remote(count) { if(remote !== count) {remote = count; render();} },
    clear() { tasks.clear(); remote = 0; expanded = false; render(); },
  };
}
