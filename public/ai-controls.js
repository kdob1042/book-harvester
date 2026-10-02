import {describeAIAction,isActiveOperation} from './ai-action-contract.js';
const runs=new Map(),inFlight=new Map();
let host,observer,pollTimer,polling=false,enabled=false,lastButton=null,lastClick=0;
const terminal=state=>['completed','canceled','failed'].includes(state);
const stopError=()=>Object.assign(new Error('AI処理を停止しました。'),{canceled:true});
function save(){try{sessionStorage.setItem('book-ai-operations',JSON.stringify([...runs.values()].filter(r=>!terminal(r.state)).map(({id,label,mode,state})=>({id,label,mode,state}))));}catch{}}
function mount(){
 if(!host)return;
 const dialogs=[...document.querySelectorAll('dialog[open]')],parent=dialogs.at(-1)||document.body;
 if(host.parentNode!==parent){if(parent===document.body)parent.append(host);else parent.insertBefore(host,parent.querySelector('.dialog-head')?.nextSibling||parent.firstChild);}
 host.classList.toggle('ai-controls-in-dialog',parent!==document.body);
}
function initialize(){
 if(host)return;
 host=document.createElement('section');host.id='ai-controls';host.className='ai-controls';host.setAttribute('aria-label','AIの処理状況');host.hidden=true;
 observer=new MutationObserver(mount);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});mount();
 document.addEventListener('click',event=>{const button=event.target.closest?.('button');if(button&&!host.contains(button)){lastButton=button;lastClick=Date.now();}},true);
 document.addEventListener('submit',event=>{if(event.submitter){lastButton=event.submitter;lastClick=Date.now();}},true);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedulePoll(0);});
 window.addEventListener('online',()=>schedulePoll(0));
 window.addEventListener('device-auth-expired',reset);
}
function reset(){enabled=false;clearTimeout(pollTimer);runs.clear();inFlight.clear();save();render();}
function render(){
 if(!host)return;mount();host.hidden=runs.size===0;
 const activeIds=new Set(runs.keys());
 for(const child of [...host.children])if(!activeIds.has(child.dataset.operation))child.remove();
 for(const run of runs.values()){
  let row=[...host.children].find(el=>el.dataset.operation===run.id);
  if(!row){
   row=document.createElement('div');row.className='ai-control';row.dataset.operation=run.id;
   const spinner=document.createElement('span');spinner.className='ai-control-spinner';spinner.setAttribute('aria-hidden','true');
   const text=document.createElement('span');text.className='ai-control-text';text.setAttribute('role','status');text.setAttribute('aria-live','polite');text.setAttribute('aria-atomic','true');
   const button=document.createElement('button');button.type='button';button.className='ai-control-stop';
   button.addEventListener('click',()=>{const current=runs.get(run.id);if(!current)return;if(terminal(current.state)){runs.delete(run.id);save();render();}else void cancelRun(current);});
   row.append(spinner,text,button);host.append(row);
  }
  const [spinner,text,button]=row.children;
  row.dataset.state=run.state;spinner.hidden=!['starting','running','queued','stopping'].includes(run.state);
  const suffix={starting:'準備中',running:'処理中',queued:'開始待ち',blocked:'待機中',stopping:'停止中',canceled:'停止しました',completed:'完了',failed:'失敗',unknown:'状態未確認'}[run.state]||'処理中';
  const label=run.cancelError?`AI ${run.label} · 停止を確認できません。再試行してください。`:`AI ${run.label} · ${suffix}`;
  if(text.textContent!==label)text.textContent=label;
  button.textContent=terminal(run.state)?'閉じる':run.cancelError?'停止を再試行':run.state==='stopping'?'停止中…':'停止';
  button.disabled=run.state==='stopping';button.setAttribute('aria-label',terminal(run.state)?`${run.label}の表示を閉じる`:`${run.label}を停止する`);
 }
}
function update(run,value){
 if(!value||!value.state||value.state==='not_found')return;
 // A status poll sent before cancellation must not resurrect a stopped operation.
 if(run.stopConfirmed&&value.state!=='canceled')return;
 if(run.state==='stopping'&&!terminal(value.state))return;
 run.state=value.state;if(value.label)run.label=value.label;
 if(value.state==='canceled')run.stopConfirmed=true;
 if(terminal(run.state)){
  run.cancelError=false;
  if(!run.dismissTimer&&run.state!=='failed')run.dismissTimer=setTimeout(()=>{if(runs.get(run.id)===run){runs.delete(run.id);save();render();}},run.state==='canceled'?2500:1600);
 }
 save();render();
}
async function control(path,options={}){
 const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
 const data=await response.json();if(!response.ok)throw Object.assign(new Error(data?.error||'状態を確認できません。'),{status:response.status});return data;
}
async function cancelRun(run){
 if(run.state==='stopping'||terminal(run.state))return;
 run.state='stopping';run.cancelError=false;render();
 try{
  const result=await control(`/api/ai-operations/${run.id}/cancel`,{method:'POST'});
  if(!terminal(result.state))throw new Error('stop_not_confirmed');
  update(run,result);
  if(result.state==='canceled'&&run.mode!=='ingestion')run.controller?.abort(stopError());
 }catch{run.state='unknown';run.cancelError=true;save();render();}
}
function schedulePoll(delay=1500){clearTimeout(pollTimer);if(enabled)pollTimer=setTimeout(poll,delay);}
async function poll(){
 if(!enabled||document.hidden||polling){schedulePoll();return;}
 polling=true;
 try{
  const local=[...runs.values()].filter(r=>isActiveOperation(r.state));
  for(const run of local){
   try{update(run,await control(`/api/ai-operations/${run.id}`));}
   catch{if(run.state!=='stopping'&&!run.stopConfirmed){run.state='unknown';render();}}
  }
  const remote=await control('/api/ai-operations');
  for(const value of remote.operations||[]){
   if(!value||terminal(value.state)||runs.has(value.id))continue;
   const run={...value};runs.set(run.id,run);update(run,value);
  }
 }catch{/* Keep visible, stoppable local operations when status cannot be verified. */}
 finally{polling=false;schedulePoll([...runs.values()].some(r=>isActiveOperation(r.state))?1500:6000);}
}
function operationKey(path,options,spec){
 if(spec.mode==='ingestion')return null;
 let body=options.body;try{body=JSON.parse(body);delete body.idempotency_key;}catch{}
 return `${options.method}:${path}:${typeof body==='string'?body:JSON.stringify(body)}`;
}
// Called before any IndexedDB or network await. Every screen, including dialogs,
// uses the same request boundary rather than maintaining a separate spinner list.
export function requestWithAIControls(path,options,request){
 initialize();
 const spec=describeAIAction(path,options.method||'GET');
 if(!spec)return request(path,options).then(data=>{
  if(path.startsWith('/api/state')&&!enabled){enabled=true;try{for(const value of JSON.parse(sessionStorage.getItem('book-ai-operations')||'[]'))if(value?.id)runs.set(value.id,{...value,state:'unknown'});}catch{}render();schedulePoll(0);}
  if(path==='/api/logout')reset();return data;
 });
 const key=operationKey(path,options,spec);if(key&&inFlight.has(key))return inFlight.get(key);
 enabled=true;const headers=new Headers(options.headers);let stableKey=headers.get('idempotency-key');try{stableKey=stableKey||JSON.parse(options.body).idempotency_key;}catch{}
 const id=headers.get('x-ai-operation-id')||(/^[a-f0-9-]{36}$/i.test(stableKey||'')?stableKey:crypto.randomUUID());headers.set('x-ai-operation-id',id);
 const run={id,...spec,state:'starting',controller:new AbortController(),button:Date.now()-lastClick<1000?lastButton:null};
 runs.set(id,run);run.button?.setAttribute('aria-busy','true');save();render();schedulePoll();
 const work=(async()=>{
  try{
   // Let the state become visible before doing expensive work or waiting on storage.
   await new Promise(resolve=>{const timer=setTimeout(resolve,50);requestAnimationFrame(()=>{clearTimeout(timer);resolve();});});
   if(run.stopConfirmed&&spec.mode!=='ingestion')throw stopError();
   if(spec.mode==='inline'){run.state='running';render();}
   const signal=options.signal?AbortSignal.any([options.signal,run.controller.signal]):run.controller.signal;
   const data=await request(path,{...options,headers,...spec.mode!=='ingestion'?{signal}:{}});
   if(run.stopConfirmed&&spec.mode!=='ingestion')throw stopError();
   if(data.ai_operation)update(run,data.ai_operation);
   else if(data.local){run.state='unknown';run.label='未送信・AI未開始';save();render();}
   else update(run,{state:'completed'});
   if(run.stopConfirmed&&spec.mode!=='ingestion')throw stopError();
   return data;
  }catch(e){
   if(run.stopConfirmed||e.canceled){update(run,{state:'canceled'});throw stopError();}
   update(run,{state:'failed'});throw e;
  }finally{run.button?.removeAttribute('aria-busy');if(key)inFlight.delete(key);}
 })();
 if(key)inFlight.set(key,work);return work;
}
