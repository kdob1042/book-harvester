import {stmt,now} from './core.ts';
export const automaticAI=(env:Env)=>env.AI_EXECUTION_POLICY!=='explicit';
export async function authorizeAI(env:Env,kind:string,target:string,version:number){await stmt(env,`INSERT INTO explicit_ai_actions VALUES(?,?,?,?) ON CONFLICT(kind,target_id) DO UPDATE SET version=excluded.version,created_at=excluded.created_at`,kind,target,version,now()).run();}
export async function allowedAI(env:Env,kind:string,target:string,version:number){return automaticAI(env)||Boolean(await stmt(env,'SELECT 1 FROM explicit_ai_actions WHERE kind=? AND target_id=? AND version=?',kind,target,version).first());}
