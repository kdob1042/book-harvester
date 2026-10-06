import {renewTerminalJobOwner} from './ai-operation-jobs.ts';
import {stmt,getCapture,fail,now} from './core.ts';
import {dispatch} from './queue.ts';
export async function startExtraction(env:Env,ctx:ExecutionContext,captureId:string,version:number){
 const c=await getCapture(env,captureId);if(!c||c.version!==version)fail(409,'capture_version_conflict');
 if(c.harvest||['pending','running'].includes(c.job?.state||''))return {id:c.job?.id,state:c.job?.state,duplicate:true};
 const statements=[
 stmt(env,`INSERT INTO explicit_ai_actions(kind,target_id,version,created_at) SELECT 'extract',id,version,? FROM captures WHERE id=? AND version=? ON CONFLICT(kind,target_id) DO UPDATE SET version=excluded.version,created_at=excluded.created_at`,now(),captureId,version),
 stmt(env,`UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=?,dispatched_at=NULL,lease_token=NULL WHERE capture_id=? AND version=? AND version=(SELECT version FROM captures WHERE id=?) AND state IN('blocked','failed','canceled')`,now(),captureId,version,captureId)];
 if(c.job?.id)await renewTerminalJobOwner(env,'capture',c.job.id,statements);else await env.DB.batch(statements);
 ctx.waitUntil(dispatch(env));return {id:c.job?.id,state:'pending',reason:'extract'};
}
