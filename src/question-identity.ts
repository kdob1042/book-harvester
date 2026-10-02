import {stmt,rows,id,now,fail} from './core.ts';
// Reuse the focus ID. Archive both texts and their histories; never create a layer.
export async function identityStatements(env:Env,target:string,sources:string[],guard:string,values:any[]){
 const edges=await rows<{parent_id:string;child_id:string}>(env,`SELECT parent_id,child_id FROM canonical_question_edges`);
 const oppositionPairs=await rows<{left_id:string;right_id:string}>(env,'SELECT left_id,right_id FROM canonical_question_oppositions');
 const resolve=(x:string)=>sources.includes(x)?target:x;
 if(oppositionPairs.some(p=>resolve(p.left_id)===resolve(p.right_id)))fail(409,'対立する仮説は同一化できません。');
 guard+=" AND NOT EXISTS(SELECT 1 FROM canonical_question_oppositions WHERE left_id IN(SELECT value FROM json_each(?)) AND right_id IN(SELECT value FROM json_each(?)))";values=[...values,JSON.stringify([target,...sources]),JSON.stringify([target,...sources])];
 const originalGuard=guard,originalValues=values;
 const graphQuery=`SELECT parent_id,child_id FROM canonical_question_edges`;
 guard+=` AND NOT EXISTS(SELECT parent_id,child_id FROM (${graphQuery}) EXCEPT SELECT json_extract(value,'$.parent_id'),json_extract(value,'$.child_id') FROM json_each(?)) AND NOT EXISTS(SELECT json_extract(value,'$.parent_id'),json_extract(value,'$.child_id') FROM json_each(?) EXCEPT SELECT parent_id,child_id FROM (${graphQuery}))`;
 values=[...values,JSON.stringify(edges),JSON.stringify(edges)];
 const canonical=(x:string)=>sources.includes(x)?target:x;
 const graph=new Map<string,Set<string>>();for(const e of edges){const a=canonical(e.parent_id),b=canonical(e.child_id);if(a===b)fail(409,'親子関係がある問いは同一化できません。');graph.set(a,(graph.get(a)||new Set()).add(b));}
 const visit=(node:string,path=new Set<string>(),done=new Set<string>()):void=>{if(path.has(node))fail(409,'循環する関係になるため同一化できません。');if(done.has(node))return;const next=new Set(path).add(node);for(const child of graph.get(node)||[])visit(child,next,done);done.add(node);};for(const node of graph.keys())visit(node);
 const gate=id();const statements=[stmt(env,`INSERT INTO theme_history SELECT ?,?,'identity_preflight',?,?,? WHERE ${guard}`,gate,target,'同一化の関係検証',JSON.stringify(edges),now(),...values)];
 guard=originalGuard+" AND EXISTS(SELECT 1 FROM theme_history WHERE id=?)";values=[...originalValues,gate];
 for(const source of sources){
  const historyId=id();
  const snapshot=await stmt(env,'SELECT * FROM themes WHERE id=?',source).first();
  statements.push(stmt(env,`INSERT INTO theme_history SELECT ?,?,'identity',?,?,? WHERE ${guard}`,historyId,target,'同じ問いを焦点の問いへ集約',JSON.stringify({source:snapshot,target}),now(),...values));
  statements.push(stmt(env,`INSERT OR IGNORE INTO theme_memberships SELECT ?,capture_id,capture_version,claim_ids,reason,role,fingerprint,processing_version,created_at FROM theme_memberships WHERE theme_id=? AND ${guard}`,target,source,...values));
  statements.push(stmt(env,`INSERT OR IGNORE INTO theme_member_lenses SELECT ?,capture_id,lens_id FROM theme_member_lenses WHERE theme_id=? AND ${guard}`,target,source,...values));
  for(const table of ['theme_domains','theme_view_links']){const cols=table==='theme_domains'?'domain_id':'view_id,reason';statements.push(stmt(env,`INSERT OR IGNORE INTO ${table} SELECT ?,${cols} FROM ${table} WHERE theme_id=? AND ${guard}`,target,source,...values));}
  statements.push(stmt(env,`INSERT OR IGNORE INTO question_relations SELECT CASE WHEN parent_id=? THEN ? ELSE parent_id END,CASE WHEN child_id=? THEN ? ELSE child_id END,type,created_at FROM question_relations WHERE (parent_id=? OR child_id=?) AND ${guard}`,source,target,source,target,source,source,...values));
 }
 // Change state last: all preceding guards still see the original versions.
 for(const source of sources)statements.push(stmt(env,`UPDATE themes SET state='merged',merged_into=?,version=version+1 WHERE id=? AND ${guard}`,target,source,...values));
 return statements;
}
