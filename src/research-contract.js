const str={type:'string'},nullable={type:['string','null']};
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const array=items=>({type:'array',items});
export const researchSchema=object({summary:str,findings:array(object({text:str,stance:{type:'string',enum:['supports','challenges','qualifies','unverified']},conditions:array(str),evidence:array(object({material_id:str,quote:str})),event_at:nullable,subject_period:nullable})),gaps:array(str),next_reading:array(object({material_id:str,reason:str}))});
export function validateResearch(result,materials){
 if(!result||typeof result.summary!=='string'||result.summary.length>2000||!Array.isArray(result.findings)||result.findings.length>8||!Array.isArray(result.gaps)||result.gaps.length>8||!Array.isArray(result.next_reading)||result.next_reading.length>3)throw Error('invalid_research');
 const map=new Map(materials.map(m=>[m.id,m]));
 for(const f of result.findings){if(typeof f.text!=='string'||f.text.length>2000||!['supports','challenges','qualifies','unverified'].includes(f.stance)||!Array.isArray(f.evidence)||f.evidence.length>6||!Array.isArray(f.conditions)||f.conditions.length>8)throw Error('invalid_research');
  if(f.stance!=='unverified'&&!f.evidence.length)throw Error('ungrounded_research');
  for(const e of f.evidence)if(!map.has(e.material_id)||typeof e.quote!=='string'||e.quote.length<8||e.quote.length>500||!map.get(e.material_id).body.includes(e.quote))throw Error('invalid_research_quote');
  for(const date of [f.event_at,f.subject_period])if(date!==null&&(typeof date!=='string'||date.length>100||!f.evidence.some(e=>e.quote.includes(date))))throw Error('invalid_research_date');
 }
 for(const n of result.next_reading)if(!map.has(n.material_id)||typeof n.reason!=='string'||n.reason.length>1000)throw Error('invalid_next_reading');
 for(const s of [...result.gaps,...result.findings.flatMap(f=>f.conditions)])if(typeof s!=='string'||s.length>2000)throw Error('invalid_research');return result;
}
