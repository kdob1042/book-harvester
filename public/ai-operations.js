import {isActiveOperation} from './ai-action-contract.js';
import {settleIntegrationAttempt} from './ai-retry.js';

const terminal = state => ['completed','failed','canceled'].includes(state);
const stopped = () => Object.assign(Error('AI処理を停止しました。'), {canceled:true});
const displayState = state => ({active:'running',queued:'pending'}[state] || state);

// Operation ownership and transport are independent of the #54 activity surface.
// Restoring this controller only issues GETs. It never replays an AI action.
export function createAiOperations({activity,request}) {
  const runs = new Map();
  let scope = null, epoch = 0, polling = false;
  const storageKey = () => `book-ai-operations:${scope}`;
  function save() {
    if(!scope)return;
    try { sessionStorage.setItem(storageKey(),JSON.stringify([...runs.values()].filter(r=>!terminal(r.state)).map(({id,label,mode,path,workflow,integrationRetry})=>({id,label,mode,path,workflow,integrationRetry})))); } catch {}
  }
  function render(run) {
    if(run.epoch!==epoch)return;
    if(terminal(run.state)&&run.integrationRetry)try{settleIntegrationAttempt(sessionStorage,run.integrationRetry,run);}catch{}
    activity.update(run.taskId,{
      state:displayState(run.state), error:run.cancelError?'停止を確認できません。接続を確認して再試行してください。':run.error||'',
      cancel:terminal(run.state)?null:()=>cancel(run), cancelError:Boolean(run.cancelError), result:run.result,
    });
    save();
  }
  function start(descriptor,{id=crypto.randomUUID(),path='',workflow=null}={}) {
    if(runs.has(id))return runs.get(id);
    const run={...descriptor,id,path,workflow,state:'running',stopRequested:false,cancelError:false,epoch};
    run.taskId=activity.start({...descriptor,cancel:()=>cancel(run)});
    runs.set(id,run);render(run);return run;
  }
  function activate(nextScope) {
    if(!nextScope||scope===nextScope)return;
    epoch++;runs.clear();activity.clear();scope=nextScope;
    try {
      const saved=JSON.parse(sessionStorage.getItem(storageKey())||'[]');
      for(const value of saved)if(typeof value?.id==='string'){
        const run=start({label:value.label||'AI処理',mode:value.mode,integrationRetry:value.integrationRetry},{...value});run.state='unknown';render(run);
      }
    } catch {}
  }
  function accept(run,value) {
    if(!value?.state||value.state==='not_found'||run.epoch!==epoch)return;
    if(run.state==='canceled'&&value.state!=='canceled')return;
    // A pending status response must not overwrite an in-flight stop request.
    if(run.state==='stopping'&&!terminal(value.state))return;
    if(terminal(run.state)&&!terminal(value.state))return;
    run.state=value.state;
    run.error=value.error||'';
    if(terminal(run.state))run.cancelError=false;
    render(run);
  }
  async function cancel(run) {
    if(run.canceling)return run.canceling;
    if(terminal(run.state))return {id:run.id,state:run.state};
    run.stopRequested=true;run.state='stopping';run.cancelError=false;render(run);
    run.canceling=(async()=>{
      try {
        const value=await request(`/api/ai-operations/${encodeURIComponent(run.id)}/cancel`,{method:'POST',cache:'no-store'});
        if(!terminal(value?.state))throw Error('停止結果を確認できません。');
        accept(run,value);return value;
      } catch(error) {
        if(run.epoch===epoch){run.state='unknown';run.cancelError=true;render(run);}
        throw error;
      } finally {run.canceling=null;}
    })();
    return run.canceling;
  }
  async function reconcile(run,value) {
    if(!value)return run;
    if(value.id&&value.id!==run.id){
      const stopRequested=run.stopRequested,owned=runs.get(value.id),ownerFinished=owned&&terminal(owned.state);
      runs.delete(run.id);
      if(owned){
        if(ownerFinished&&run.integrationRetry)try{settleIntegrationAttempt(sessionStorage,run.integrationRetry,owned);}catch{}
        activity.update(owned.taskId,{open:run.open,detail:run.detail});owned.path ||= run.path;owned.integrationRetry ||= run.integrationRetry;activity.remove(run.taskId);run=owned;
      }
      else{run.id=value.id;runs.set(run.id,run);}
      // A duplicate request observes its original job; it never steals ownership.
      run.stopRequested ||= stopRequested;
      if(!ownerFinished)run.state=value.state;
      run.label=value.label||run.label;run.workflow=value.workflow||null;run.path=value.path||run.path;
      activity.update(run.taskId,{label:run.label});run.cancelError=false;render(run);
      if(stopRequested&&!terminal(value.state))await cancel(run);
    }
    accept(run,value);return run;
  }
  async function execute(path,options,descriptor,existing) {
    const headers=new Headers(options.headers);
    const run=existing||start(descriptor,{path,id:headers.get('x-ai-operation-id')||undefined});
    headers.set('x-ai-operation-id',run.id);
    if(run.workflow)headers.set('x-ai-operation-workflow',run.workflow);
    if(run.state==='canceled')throw stopped();
    if(run.stopRequested)throw Object.assign(Error('停止結果は未確認です。処理状況から確認・再試行してください。'),{stopPending:true});
    let owner=run;
    try {
      const result=await request(path,{...options,headers});
      if(run.epoch!==epoch)throw Error('');
      owner=await reconcile(run,result.ai_operation);
      owner.result=result;
      if(descriptor.mode!=='ingestion'&&(result.canceled||owner.state==='canceled'))throw stopped();
      if(!result.ai_operation){
        // HTTP acceptance alone never means queued AI has completed.
        owner.state=result.local?'unknown':descriptor.mode==='inline'?'completed':'pending';
        if(result.local)owner.error='未送信です。AIの開始は確認できません。';
        render(owner);
      }else render(owner);
      return result;
    } catch(error) {
      if(error.ai_operation)owner=await reconcile(owner,error.ai_operation);
      if(owner.state==='canceled'||error.canceled){accept(owner,{state:'canceled'});throw stopped();}
      // Network failure is ambiguous. Keep the operation stoppable until verified.
      if(!terminal(owner.state)&&owner.state!=='stopping'){
        if(!error.ai_operation)owner.state='unknown';
        owner.error=error.message;render(owner);
      }
      throw error;
    }
  }
  async function refresh() {
    if(!scope||polling)return;
    polling=true;const currentEpoch=epoch;
    try {
      await Promise.all([...runs.values()].filter(r=>isActiveOperation(r.state)).map(async run=>{
        try {accept(run,await request(`/api/ai-operations/${encodeURIComponent(run.id)}`,{cache:'no-store'}));}
        catch {/* Retain stop/retry controls when the status cannot be verified. */}
      }));
      const remote=await request('/api/ai-operations',{cache:'no-store'});
      if(currentEpoch!==epoch)return;
      for(const value of remote.operations||[]){
        if(!value?.id||terminal(value.state))continue;
        const run=runs.get(value.id)||start({label:value.label||'AI処理',mode:value.mode},{id:value.id,path:value.path,workflow:value.workflow});
        accept(run,value);
      }
    } finally {polling=false;}
  }
  function clear() {epoch++;runs.clear();save();scope=null;activity.clear();}
  function find(path) {return [...runs.values()].find(run=>run.path===path&&isActiveOperation(run.state));}
  return {activate,start,execute,refresh,cancel,find,clear};
}
