import {graphResult,graphResponse} from './helpers.js';
export const a='共通設備を外部利用すると利用者の初期投資が下がる。';
export const b='設備提供者に需要が集まると稼働率が高まる。';
export const viewA='参入しやすさは利用者の投資額で判断する。\n景気の見方は変えない。';
export function material(sentence,title){
 return {source:{title,page:'1',chapter:null,published_at:null,subject_period:null,certainty:'explicit'},extracted_text:sentence,summary:sentence,uncertainties:[],
  claims:[{id:'c1',text:sentence,conditions:['外部利用が可能な場合'],evidence:{origin:'source',quote:sentence,locator:'p.1',certainty:'explicit'}}],
  concepts:[{id:'k1',name:sentence===a?'設備の共有':'設備の集約',description:sentence===a?'利用者が固定投資を負担せずに設備を利用する仕組み':'供給側の設備へ需要を集める仕組み',claim_ids:['c1']}],
  questions:[{id:'q1',text:'どの条件で有効になるか？',claim_ids:['c1']}],view_draft:{text:sentence===a?viewA:'設備の提供側に需要が集まる条件を見る。',reason:'資料に基づく案',claim_ids:['c1']}};
}
export function connectedGraph(input){
 const out=graphResult(input);if(input.current.harvest.extracted_text!==b)return out;
 const past=input.candidates.nodes.find(n=>n.kind==='claim'&&n.text===a);if(!past)return out;
 out.relations.push({id:'r2',from_id:'c1',to_id:past.id,type:'analogous_to',reason:'設備利用者の固定費軽減と提供者の稼働率は主体が異なり併存する。',conditions:['外部利用と需要集約が成立する場合'],interpretation:'ai_analogy',evidence:[{claim_id:'c1',quote:b},{claim_id:past.id,quote:a}]});
 out.discoveries=[{relation_id:'r2',text:'利用者の参入しやすさと提供者の規模の優位は併存し得る。',common_structure:'設備の利用を集め、固定負担を分ける構造。',important_difference:'Aは利用者の投資額、Bは提供者の稼働率を説明する。'}];
 const v=input.candidates.views.find(v=>v.body.includes(viewA.split('\n')[0]));if(v)out.view_proposal={view_id:v.id,base_version:v.version,from_text:viewA.split('\n')[0],to_text:'利用者の参入しやすさと設備提供者の規模の優位は、外部利用と需要集約の条件下で併存し得る。',reason:'両側の資料は異なる主体を説明しているため。',evidence:out.relations.at(-1).evidence};
 return out;
}
export async function semanticMock(url,opts){
 if(url.endsWith('/audio/transcriptions'))return Response.json({text:b});
 const body=JSON.parse(opts.body);
 if(body.text.format.name==='theme_membership_v1')return graphResponse({},{memberships:[],candidate:null});
 if(body.text.format.name==='knowledge_graph_v1'){const input=JSON.parse(body.input);return graphResponse(input,connectedGraph(input));}
 const text=JSON.parse(body.input[0].content[0].text).original_or_corrected_text.trim();
 const value=material(text,text===a?'本A':text===b?'本B':'本C');
 return graphResponse({},value);
}
