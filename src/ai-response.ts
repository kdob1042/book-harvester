import {fail} from './core.ts';
import {call,AiError} from './ai.ts';

export async function respond(env:Env, name:string, schema:unknown, instructions:string, input:unknown, fetcher?:typeof fetch) {
 instructions += ' 主題questionと内容contentをセットで参照する。内容は問題意識や仮説であり原根拠ではない。新しい親の問いでは元の問題意識を保ったcontentを生成する。';
 const serialized = JSON.stringify(input);
 if (serialized.length > 150000) fail(413,'材料が大きすぎます。範囲を減らしてください。');
 const response = await call(env,null,'responses',env.OPENAI_MODEL,{
  model:env.OPENAI_MODEL,store:false,instructions,input:serialized,
  max_output_tokens:Number(env.AI_MAX_OUTPUT_TOKENS),
  text:{format:{type:'json_schema',name,strict:true,schema}}
 },fetcher);
 if (response.status === 'incomplete') throw new AiError('incomplete_output');
 return JSON.parse((response.output || []).flatMap(o => o.content || [])
  .filter(b => b.type === 'output_text').map(b => b.text).join(''));
}
