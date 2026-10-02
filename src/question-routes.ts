import {rows,jsonBody} from './core.ts';
import {suggestRelations,saveRelation,removeOpposition} from './question-relations.ts';
import {drilldown,saveDrilldown,addDrilldownCandidate} from './drilldown.ts';
import {readProposals,generateProposals,executeProposals} from './integration-proposals.ts';
import {readDiscovery,latestDiscovery,integrateRecords} from './discovery.ts';
import {themeContext} from './book-actions.ts';
import {listThemes,readTheme,actThemeProposal,themeMigrationStatus,manageThemeMigration,editTheme,deleteTheme,overrideTheme,mergeTheme} from './themes.ts';
import {dispatch} from './queue.ts';
import type {callBook} from './book-operations.ts';
const json = (data:unknown,status=200) => Response.json(data,{status});

// Authentication, origin checks and receipt replay remain in the HTTP entrypoint.
// Passing the operation dispatcher avoids a runtime route/operation import cycle.
export async function questionRoutes(request:Request,env:Env,ctx:ExecutionContext,url:URL,operate:typeof callBook):Promise<Response|null>{
 const path=url.pathname,method=request.method;
 if(!path.startsWith('/api/themes')&&!path.startsWith('/api/theme-changes')&&!path.startsWith('/api/book/'))return null;
 const relation=/^\/api\/themes\/([^/]+)\/relationships(?:\/(save|remove))?$/.exec(path);
 if(relation&&method==='POST')return json(await (relation[2]==='save'?saveRelation:relation[2]==='remove'?removeOpposition:suggestRelations)(env,decodeURIComponent(relation[1]),await jsonBody(request.clone())));
 const drill=/^\/api\/themes\/([^/]+)\/drilldown(?:\/(save|candidates))?$/.exec(path);
 if(drill&&method==='POST')return json(await (drill[2]==='candidates'?addDrilldownCandidate:drill[2]?saveDrilldown:drilldown)(env,decodeURIComponent(drill[1]),await jsonBody(request.clone())));
 if(path==='/api/book/integration-proposals'&&method==='GET')return json(await readProposals(env,url.searchParams.get('id')||undefined));
 if(path==='/api/book/integration-proposals'&&method==='POST')return json(await generateProposals(env,await jsonBody(request.clone())));
 if(path==='/api/book/integration-proposals/execute'&&method==='POST')return json(await executeProposals(env,await jsonBody(request.clone())));
 if(path==='/api/book/integrate'&&method==='POST')return json(await integrateRecords(env,await jsonBody(request.clone())));
 if(path==='/api/book/discovery'&&method==='GET')return json(url.searchParams.has('id')?await readDiscovery(env,url.searchParams.get('id')!):await latestDiscovery(env,url.searchParams.get('anchor')!));
 if(path==='/api/book/discover'&&method==='POST')return json(await operate(env,ctx,'discover_relations',await jsonBody(request.clone())),202);
 const themeAction=/^\/api\/themes\/([^/]+)\/(context|analysis|rebuild)$/.exec(path);
 if(themeAction){
 const a={...await (method==='GET'?Promise.resolve({}):jsonBody(request.clone())),id:decodeURIComponent(themeAction[1])};
 if(themeAction[2]==='context'&&method==='GET')return json(await themeContext(env,a.id));
 if(themeAction[2]==='analysis'&&method==='POST')return json(await operate(env,ctx,'save_analysis_draft',a),201);
 if(themeAction[2]==='rebuild'&&method==='POST')return json(await operate(env,ctx,'rebuild_theme',a),202);}
 if(path==='/api/theme-changes'&&method==='POST')return json(await operate(env,ctx,'propose_theme_change',await jsonBody(request.clone())),201);
 const themeChange=/^\/api\/theme-changes\/([a-f0-9-]{36})(?:\/(apply|undo))?$/.exec(path);
 if(themeChange){if(!themeChange[2]&&method==='GET')return json(await operate(env,ctx,'get_theme_change',{id:themeChange[1]}));
 if(themeChange[2]&&method==='POST')return json(await operate(env,ctx,themeChange[2]==='apply'?'apply_theme_change':'undo_theme_change',{...await jsonBody(request.clone()),id:themeChange[1]}));}
 if(path==='/api/book/visibility'&&method==='POST')return json(await operate(env,ctx,'set_visibility',await jsonBody(request.clone())));
 if(path==='/api/themes/migration'&&method==='GET')return json(await themeMigrationStatus(env));
 if(path==='/api/themes/migration'&&method==='POST'){const r=await manageThemeMigration(env,await jsonBody(request.clone()));
 ctx.waitUntil(dispatch(env));
 return json(r);}
 if(path==='/api/themes'&&method==='GET')return json(await listThemes(env));
 const themeMatch=/^\/api\/themes\/([^/]+)(?:\/(proposals|history|overrides|merge))?$/.exec(path);
 if(themeMatch){
 const themeId=decodeURIComponent(themeMatch[1]);
 if(!themeMatch[2]&&method==='PATCH')return json(await editTheme(env,themeId,await jsonBody(request.clone())));
 if(!themeMatch[2]&&method==='DELETE')return json(await deleteTheme(env,themeId,await jsonBody(request.clone())));
 if(themeMatch[2]==='merge'&&method==='POST')return json(await mergeTheme(env,themeId,await jsonBody(request.clone())));
 if(themeMatch[2]==='overrides'&&method==='POST')return json(await overrideTheme(env,themeId,await jsonBody(request.clone())));
 if(!themeMatch[2]&&method==='GET')return json(await readTheme(env,themeId));
 if(themeMatch[2]==='history'&&method==='GET'){
 await readTheme(env,themeId);
 return json(await rows(env,'SELECT * FROM theme_revisions WHERE theme_id=? ORDER BY version DESC LIMIT 20',themeId));}if(themeMatch[2]==='proposals'&&method==='POST')return json(await actThemeProposal(env,themeId,await jsonBody(request.clone())));}
 return null;
}
