const sessions = new Map();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = data => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const size = field => {field.style.height='auto';field.style.height=`${field.scrollHeight+2}px`;};
export const clearDrilldowns = () => sessions.clear();

// A request belongs to its question, rather than to a disposable dialog DOM.
export function mountDrilldown(root,{themeId,version,initialRun,api,open,openTheme}) {
 let session=sessions.get(themeId);
 if(!session||session.version!==version){session={version,run:null,parent:null,selected:new Set(),saved:new Map(),busy:false,error:'',loaded:false};sessions.set(themeId,session);}
 const s=session, path=`/api/themes/${encodeURIComponent(themeId)}/drilldown`;
 function accept(run){
  if(s.run?.id===run.id)return;
  s.run=run;s.selected=new Set(run.candidates.map((_,i)=>i));s.saved=new Map((run.saved||[]).map(c=>[c.candidate_index,c.child_id]));s.newSearch=false;
 }
 if(initialRun)accept(initialRun);
 const current=()=>root.isConnected;
 const update=()=>s.render?.();
 function render(){
  if(!current())return;
  const run=s.run;
  root.innerHTML=`<p class="dd-origin">${esc(s.parent?.question||'')}</p><form id="drilldown-form" ${run&&!s.newSearch?'hidden':''}><label><span>方向（任意）</span><input id="drilldown-direction" maxlength="1000" value="${esc(s.direction||'')}"></label><button class="primary" ${s.busy||!s.loaded?'disabled':''}>AIで候補を出す</button></form><p id="drilldown-status" role="status">${s.busy?'探索中…':run?`探索結果 · ${run.candidates.length}件`:s.loaded?'':'読み込み中…'}</p><p id="drilldown-error" class="error" role="alert">${esc(s.error)}</p><section id="drilldown-candidates"></section>${run?'<button id="drilldown-again" class="quiet">もう一度探索</button>':''}<form id="drilldown-manual" ${run?'':'hidden'}><label><span>主題</span><textarea id="drilldown-title" rows="2" maxlength="200" required></textarea></label><label><span>内容（任意）</span><textarea id="drilldown-content" maxlength="10000"></textarea></label><button class="quiet" ${s.busy?'disabled':''}>候補に追加</button></form><button id="drilldown-link" class="primary" ${run?'':'hidden'}>選んだ問いをつなぐ</button>`;
  const $=selector=>root.querySelector(selector);
  if(run){
   $('#drilldown-candidates').innerHTML=run.candidates.map((c,i)=>{
    const done=s.saved.has(i), parents=[{id:themeId,question:s.parent?.question||'元の問い'},...(run.oppositions||[])];
    const attached=id=>id===themeId?c.target!=='opposite':c.target!=='selected'&&c.opposite_id===id;
    return `<article class="dd-candidate"><label class="dd-adopt"><input type="checkbox" data-drilldown-select="${i}" ${s.selected.has(i)?'checked':''} ${done?'disabled':''}>${done?'接続済み':'この問いを採用'}</label><div class="dd-map" role="group" aria-label="接続する元の問い"><div class="dd-parents">${parents.map(p=>`<label class="dd-parent ${attached(p.id)?'dd-attached':''}"><input type="checkbox" data-drilldown-parent="${i}" value="${esc(p.id)}" ${attached(p.id)?'checked':''} ${done?'disabled':''}><span class="dd-kind">${p.id===themeId?'元の問い':'対立する問い'}</span><span class="dd-parent-title">${esc(p.question)}</span></label>`).join('')}</div><div class="dd-child"><span class="dd-kind">掘り下げた問い</span><textarea aria-label="主題" rows="2" data-drilldown-question="${i}" maxlength="200" ${done?'disabled':''}>${esc(c.question)}</textarea></div></div><label class="dd-content"><span>確かめたいこと</span><textarea aria-label="内容" data-drilldown-content="${i}" maxlength="10000" ${done?'disabled':''}>${esc(c.content||'')}</textarea></label>${c.origin==='user'?'':`<details class="fold"><summary>提案の理由</summary><p class="prose">${esc(c.reason)}</p></details>`}${done?`<button class="back" data-drilldown-open="${esc(s.saved.get(i))}">開く</button>`:''}</article>`;
   }).join('');
   root.querySelectorAll('[data-drilldown-question]').forEach(field=>{size(field);field.oninput=()=>{run.candidates[Number(field.dataset.drilldownQuestion)].question=field.value;size(field);};});
   root.querySelectorAll('[data-drilldown-content]').forEach(field=>{size(field);field.oninput=()=>{run.candidates[Number(field.dataset.drilldownContent)].content=field.value;size(field);};});
   root.querySelectorAll('[data-drilldown-parent]').forEach(field=>field.onchange=()=>{
    const c=run.candidates[Number(field.dataset.drilldownParent)],isSource=field.value===themeId;
    let source=c.target!=='opposite',other=c.target!=='selected'?c.opposite_id:null;
    if(isSource)source=field.checked;else other=field.checked?field.value:null;
    if(!source&&!other){field.checked=true;return;}
    c.target=source?(other?'both':'selected'):'opposite';c.opposite_id=other;render();
   });
   root.querySelectorAll('[data-drilldown-select]').forEach(field=>field.onchange=()=>{const i=Number(field.dataset.drilldownSelect);field.checked?s.selected.add(i):s.selected.delete(i);updateLink();});
   root.querySelectorAll('[data-drilldown-open]').forEach(button=>button.onclick=()=>openTheme(button.dataset.drilldownOpen));
   $('#drilldown-again').onclick=()=>{s.newSearch=true;render();$('#drilldown-direction').focus();};
  }
  function updateLink(){const count=[...s.selected].filter(i=>!s.saved.has(i)).length;$('#drilldown-link').disabled=s.busy||!count;}
  updateLink();
  $('#drilldown-direction').oninput=e=>s.direction=e.target.value;
  $('#drilldown-form').onsubmit=async e=>{
   e.preventDefault();if(s.busy||!s.loaded)return;s.busy=true;s.error='';render();
   try{accept(await api(path,{...json({version,direction:s.direction||''}),aiActivity:{open:result=>open(themeId,version,result)}}));}
   catch(error){s.error=error.message;}finally{s.busy=false;update();}
  };
  $('#drilldown-manual').onsubmit=async e=>{
   e.preventDefault();if(s.busy)return;
   const question=$('#drilldown-title').value,content=$('#drilldown-content').value,edits=s.run.candidates;
   s.busy=true;s.error='';$('#drilldown-manual button').disabled=true;updateLink();
   try{const result=await api(`${path}/candidates`,json({run_id:s.run.id,question,content}));edits.forEach((c,i)=>result.candidates[i]=c);s.run=result;s.selected.add(result.candidates.length-1);}
   catch(error){s.error=error.message;}finally{s.busy=false;update();}
  };
  $('#drilldown-link').onclick=async()=>{
   if(s.busy)return;s.busy=true;s.error='';updateLink();
   const choices=[...s.selected].filter(i=>!s.saved.has(i)).map(i=>[i,{...s.run.candidates[i],content:s.run.candidates[i].content||''}]);
   try{for(const [i,candidate] of choices){const child=await api(`${path}/save`,json({run_id:s.run.id,candidate_index:i,candidate}));s.saved.set(i,child.id);}}
   catch(error){s.error=error.message;}finally{s.busy=false;update();}
  };
 }
 s.render=render;render();
 if(!s.loaded&&!s.loading){
  s.loading=true;
  api(path).then(data=>{s.parent=data.parent;if(!s.run&&data.run)accept(data.run);s.loaded=true;}).catch(error=>{s.error=error.message;s.loaded=true;}).finally(()=>{s.loading=false;update();});
 }
}
