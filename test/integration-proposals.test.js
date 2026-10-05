import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,result,graphResponse} from './helpers.js';
import {generateProposals,readProposals,executeProposals,proposalConflict} from '../src/integration-proposals.ts';
import {hasProposalHypothesis} from '../src/integration-proposal-contract.js';
function insert(f,id,text,domain='work',lens='constraint',created=0){const h=result();h.extracted_text=text;h.summary=text;h.claims=[{id:'c1',text,conditions:[],evidence:{origin:'user',quote:text,locator:null,certainty:'explicit'}}];h.questions=[];h.concepts=[];h.view_draft=null;h.classification={domain_ids:[domain],lens_ids:[lens]};f.db.prepare("INSERT INTO captures(id,kind,original_text,note,version,created_at,updated_at,mutation_id,request_key,request_hash) VALUES(?,'text',?,'',1,?,?,?,?,'hash')").run(id,text,created,created,id,id);f.db.prepare('INSERT INTO harvests(capture_id,version,result,created_at) VALUES(?,1,?,?)').run(id,JSON.stringify(h),created);}
function output(i){return {changed:true,change_reason:'条件を整理',understanding:[{id:'u1',text:'作成後の検証が制約になる場合がある',interpretation:'ai',period:null,evidence:i.claims.map(c=>({claim_id:c.id,quote:c.evidence.quote,role:'condition'}))}],changes:[],competing:[],conditions:[],questions:[],relations:[],theme_relations:[],view_proposal:null};}
test('saved proposals replay without AI, execute independently and retry only failures',async t=>{
 const f=await fixture();t.after(f.close);for(const mid of ['a','b','c','d'])insert(f,mid,'AI制作の検証 '+mid);let calls=0,failSecond=true;
 const ai=async(url,options)=>{calls++;const payload=JSON.parse(options.body),input=JSON.parse(payload.input);
 if(payload.text.format.name==='integration_proposals_v1')return graphResponse({},{proposals:[['a','b'],['c','d']].map(material_ids=>({material_ids,theme_id:null,question:'AI制作が容易になるほど、検証が価値の源泉になるのではないか？',hypothesis:'AI制作が容易になるほど、検証が価値の源泉になる。',falsifier:'検証なしでも同等の品質と継続対価が得られる。',scope:'制作',exclusions:'',reason:'制約の比較'}))});
 if(input.selected_ids.includes('c')&&failSecond)throw Error('temporary failure');return graphResponse({},output(input));};
 const args={idempotency_key:'batch-proposals-1'};const run=await generateProposals(f.env,args,ai);assert.equal(run.proposals.length,2);assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,0);
 await readProposals(f.env,run.id);await generateProposals(f.env,args,ai);assert.equal(calls,1);
 const execute={run_id:run.id,selected_ids:run.proposals.map(p=>p.id)};const saved=await executeProposals(f.env,execute,ai);assert.deepEqual(saved.proposals.map(p=>p.state),['completed','failed']);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,1);
 const theme=f.db.prepare('SELECT question,content FROM themes WHERE id=?').get(saved.proposals[0].result.theme_id);assert.equal(theme.question,run.proposals[0].question);assert.match(theme.content,/暫定仮説：[\s\S]+反証となる観察：/);
 const before=calls;await executeProposals(f.env,execute,ai);assert.equal(calls,before);failSecond=false;const retried=await executeProposals(f.env,{...execute,retry:true},ai);assert.ok(retried.proposals.every(p=>p.state==='completed'));assert.equal(calls,before+1);assert.equal(f.db.prepare('SELECT count(*) n FROM theme_revisions').get().n,2);
});
test('shared captures allowed; updating a question another proposal reads conflicts',()=>{const a={destination_id:null,materials:[{id:'a'}]},b={destination_id:null,materials:[{id:'a'}]};assert.equal(proposalConflict(a,b),false);a.destination_id='theme:x';b.materials.push({id:'theme:x'});assert.equal(proposalConflict(a,b),true);});
test('unknown AI material IDs fail without saving proposals',async t=>{const f=await fixture();t.after(f.close);insert(f,'a','AI制作');insert(f,'b','AI制作後の検証');await assert.rejects(generateProposals(f.env,{idempotency_key:'batch-invalid'},async()=>graphResponse({},{proposals:[{material_ids:['a','missing'],theme_id:null,question:'問い',scope:'制作',exclusions:'',reason:'比較'}]})),/invalid_proposals/);assert.equal(f.db.prepare('SELECT count(*) n FROM integration_proposals').get().n,0);});
test('open-ended proposals are omitted before saving even with hypothesis fields',async t=>{
 const f=await fixture();t.after(f.close);insert(f,'a','AI制作');insert(f,'b','AI制作後の検証');
 const base={material_ids:['a','b'],theme_id:null,scope:'制作',exclusions:'',reason:'制作費が低下するほど、残る検証の制約が対価を左右する。',hypothesis:'AI制作が容易になるほど、検証が価値の源泉になる。',falsifier:'検証なしでも同等の品質と継続対価が得られる。'};
 const good={...base,question:'AI制作が容易になるほど、検証が価値の源泉になるのではないか？'};
 assert.equal(hasProposalHypothesis(good),true);assert.equal(hasProposalHypothesis({...good,falsifier:''}),false);
 const run=await generateProposals(f.env,{idempotency_key:'stance-regression'},async(url,options)=>{
  const payload=JSON.parse(options.body);assert.ok(payload.text.format.schema.properties.proposals.items.required.includes('hypothesis'));assert.match(payload.instructions,/反証可能/);
  return graphResponse({},{proposals:[{...base,question:'AIによる豊かさがお金に依存しない生活保障につながる条件は何か？'},{...base,question:'今後5〜10年のAIによる作業再編は、どのような条件で必要人数や賃金の低下につながるのか？'},good]});
 });
 assert.deepEqual(run.proposals.map(p=>p.question),[good.question]);assert.equal(f.db.prepare('SELECT count(*) n FROM discovery_runs').get().n,1);
});
