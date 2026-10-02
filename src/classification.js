export const domainIds=['work','learning','creation','community','care','value','technology'];
export const lensIds=['substitution','constraint','concentration','personalization','capture'];
export const classificationInstructions=`同じ取り込み応答でclassificationを付ける。domain_idsはwork=仕事・組織、learning=学び・能力、creation=創作・娯楽、community=人間関係・共同体、care=暮らし・ケア、value=経済・分配、technology=技術・インフラから最大2。AIという語でtechnologyにせず、記録が何を考えているかで選ぶ。technologyは計算資源・通信・電力・性能・物理制約。lens_idsはsubstitution=代替と補完、constraint=制約の移動、concentration=集中と分散、personalization=標準化と個別化、capture=価値の生産と獲得から最大2。普通の感想や断片には型を無理に付けず空配列。自由タグを作らない。分類は検索の手掛かりであり、所属・関連・因果の確定ではない。`;
const overlap=(a=[],b=[])=>a.some(x=>b.includes(x));
export function tokens(text){const s=text.normalize('NFKC').toLowerCase();return [...new Set([...s.matchAll(/[a-z0-9]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu)].flatMap(m=>/^[a-z0-9]+$/.test(m[0])?[m[0]]:Array.from({length:m[0].length-1},(_,i)=>m[0].slice(i,i+2))))];}
export function shortlist(anchor,records,limit=30){
 const terms=new Set(tokens(anchor.text));const seen=new Set([anchor.fingerprint]);
 const ranked=records.map(r=>{const near=overlap(anchor.domain_ids,r.domain_ids),lens=overlap(anchor.lens_ids,r.lens_ids),matches=tokens(r.text).filter(t=>terms.has(t)).length;return {...r,near,score:matches+Number(near)*4+Number(lens)*5+Number(Boolean(r.linked))*4};}).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
 const unique=ranked.filter(r=>{if(seen.has(r.fingerprint))return false;seen.add(r.fingerprint);return true;});
 // Preserve distant structural comparisons instead of letting one domain exhaust the budget.
 const near=unique.filter(r=>r.near).slice(0,22),cross=unique.filter(r=>!r.near).slice(0,8);
 return [...near,...cross,...unique.filter(r=>!near.includes(r)&&!cross.includes(r))].slice(0,limit);
}
export function selectCandidates(output,pool){
 if(!Array.isArray(output)||output.length>30)throw Error('invalid_discovery');const seen=new Set();
 const valid=output.map(c=>{const r=pool.find(r=>r.id===c.id);if(!r||seen.has(c.id)||!['common','support','counterexample','condition','analogy','question','same_question'].includes(c.relation)||typeof c.reason!=='string'||!c.reason.trim()||c.reason.length>300||!Number.isInteger(c.relevance)||c.relevance<0||c.relevance>3)throw Error('invalid_discovery');seen.add(c.id);return {...r,...c};}).filter(c=>c.relevance>=2);
 valid.sort((a,b)=>Number(b.near)-Number(a.near)||b.relevance-a.relevance||a.id.localeCompare(b.id));
 const selected=valid.filter(c=>c.near).slice(0,4);const counter=valid.find(c=>['counterexample','condition'].includes(c.relation));if(counter&&!selected.includes(counter)){if(selected.length===4)selected.pop();selected.push(counter);}
 for(const c of valid.filter(c=>!c.near).slice(0,2))if(!selected.includes(c)&&selected.length<5)selected.push(c);
 for(const c of valid)if(!selected.includes(c)&&selected.length<5)selected.push(c);
 return selected.sort((a,b)=>Number(b.near)-Number(a.near)||b.relevance-a.relevance);
}
