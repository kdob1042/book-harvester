import {registerAIActivityAdapter} from './ai-controls.js';
// One activity surface for the whole app, independent of page and dialog contents.
export function createAiActivity() {
  const root = document.createElement('aside');
  root.id = 'ai-activity'; root.className = 'ai-dock'; root.hidden = true;
  root.setAttribute('popover', 'manual'); root.setAttribute('aria-label', 'AIの処理状況');
  const tasks = new Map(),operationTasks=new Map(); let expanded = false, remote = 0, serial = 0;
  const active = task => ['running', 'pending'].includes(task.state);
  const stoppable = task => task.cancel && ['running','pending','blocked','unknown','stopping'].includes(task.state);
  const labels = { running:'中', pending:'待ち', completed:'完了', failed:'失敗', blocked:'中断', canceled:'停止済み', offline:'接続待ち', waiting:'範囲選択待ち', unknown:'状態未確認', stopping:'停止中' };
  const button = (text, action, key) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = text;
    el.dataset.aiFocus = key; el.addEventListener('click', action); return el;
  };
  function mount(parent) {
    parent ||= [...document.querySelectorAll('dialog[open]')].filter(d => d.matches(':modal')).at(-1) || document.body;
    if (root.parentNode !== parent) {
      if (root.matches(':popover-open')) root.hidePopover();
      parent.append(root);
    }
    if (!root.hidden && root.showPopover && !root.matches(':popover-open')) root.showPopover();
  }
  function stopButton(task) {
    const el=button(task.state==='stopping'?'停止中…':task.stopUnconfirmed?'停止を再試行':'停止',async()=>{
      try { await task.cancel(); if(!task.controlled)update(task.id,{state:'canceled'}); }
      catch(error) { task.error=error.message; render(); }
    },`cancel-${task.id}`);
    el.disabled=task.state==='stopping';return el;
  }
  function render() {
    const focus = root.contains(document.activeElement) ? document.activeElement.dataset.aiFocus : null;
    const visible = [...tasks.values()].filter(t => !t.acknowledged);
    const running = visible.filter(active), count = Math.max(running.length, remote);
    const latest = visible.find(t => ['failed','blocked','unknown','stopping'].includes(t.state)) || visible.at(-1);
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
        if (['failed','blocked','unknown'].includes(task.state)) status.classList.add('error');
        row.append(name, status);
        const actions = document.createElement('div'); actions.className = 'ai-dock-actions';
        if (task.open&&task.state!=='canceled') actions.append(button(active(task) ? '対象を開く' : '見る', async () => {
          const wasActive = active(task);
          try { await task.open(task.result); if(!wasActive) task.acknowledged = true; expanded = false; render(); }
          catch(error) { task.error = error.message; render(); }
        }, `open-${task.id}`));
        if (stoppable(task)) actions.append(stopButton(task));
        if (!active(task)&&!stoppable(task)) actions.append(button('消す', () => { tasks.delete(task.id); render(); }, `dismiss-${task.id}`));
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
    if (!count) ring.textContent = visible.some(t => ['failed','blocked','unknown'].includes(t.state)) ? '!' : ['waiting','offline'].includes(latest.state) ? '…' : '✓';
    const text = document.createElement('span'); text.textContent = summary; text.setAttribute('role', 'status'); text.setAttribute('aria-live', 'polite');
    trigger.append(ring, text);
    const footer=document.createElement('div');footer.className='ai-dock-footer';footer.append(trigger);
    const stops=visible.filter(stoppable);if(!expanded&&stops.length===1){const stop=stopButton(stops[0]);stop.classList.add('ai-dock-quick-stop');footer.append(stop);}
    children.push(footer);root.replaceChildren(...children); mount();
    if (focus) [...root.querySelectorAll('[data-ai-focus]')].find(el => el.dataset.aiFocus === focus)?.focus({preventScroll:true});
  }
  function update(id, values) {
    const task=tasks.get(id);if(!task)return;
    // Page callbacks can attach results but cannot undo a confirmed stop.
    if(task.controlled){values={...values};delete values.state;delete values.cancel;if(task.state==='canceled')delete values.error;}
    if(Object.entries(values).some(([key,value])=>task[key]!==value)){Object.assign(task,values);render();}
  }
  new MutationObserver(() => { if(!root.hidden) mount(); }).observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['open']});
  document.addEventListener('close', () => mount(), true);
  document.body.append(root);
  const api={
    start(descriptor) {
      if(tasks.size >= 20) for(const [id,task] of tasks) if(!active(task)&&!stoppable(task)) {tasks.delete(id); break;}
      const id = ++serial; tasks.set(id, {...descriptor, cancel:null, id, state:'running'}); render(); return id;
    },
    update, mount,
    remote(count) { const value=[...tasks.values()].some(t=>t.controlled&&(stoppable(t)||Date.now()-t.controlUpdated<3000))?0:count;if(remote!==value){remote=value;render();} },
    clear() { tasks.clear(); remote = 0; expanded = false; render(); },
  };
  registerAIActivityAdapter({
    update(run,cancel){
      let task=tasks.get(operationTasks.get(run.id));
      if(!task&&operationTasks.has(run.id))return;
      if(!task){task=[...tasks.values()].reverse().find(t=>!t.controlled&&active(t));if(!task)task=tasks.get(api.start({label:run.label}));task.operationId=run.id;task.controlled=true;operationTasks.set(run.id,task.id);}
      const state={starting:'running',queued:'pending'}[run.state]||run.state;
      const canStop=['running','pending','blocked','unknown','stopping'].includes(state);
      const error=run.cancelError?'停止を確認できません。再試行してください。':state==='canceled'?'':task.error;
      if(task.state!==state||task.error!==error||task.stopUnconfirmed!==Boolean(run.cancelError)||Boolean(task.cancel)!==canStop){
        task.state=state;task.controlUpdated=Date.now();task.error=error;task.stopUnconfirmed=Boolean(run.cancelError);task.cancel=canStop?cancel:null;remote=0;render();
      }
    }
  });
  return api;
}
