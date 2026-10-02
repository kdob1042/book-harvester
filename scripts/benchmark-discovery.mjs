import {performance} from 'node:perf_hooks';
import {fixture,result,graphResponse} from '../test/helpers.js';
import {generateProposals} from '../src/integration-proposals.ts';

// Synthetic data and a provider double: no credentials or external AI requests.
const size = Number(process.argv[2] || 200);
if (!Number.isInteger(size) || size < 2 || size > 10000) throw Error('Use a size between 2 and 10000');
const f = await fixture();
try {
 for (let i = 0; i < size; i++) {
  const id = `benchmark:${String(i).padStart(6,'0')}`, h = result();
  h.summary = h.extracted_text = `AI制作の検証と条件 ${i}`;
  f.db.prepare(`INSERT INTO captures(id,kind,original_text,note,version,created_at,updated_at,mutation_id,request_key,request_hash)
   VALUES(?,'text',?,'',1,0,0,?,?,'hash')`).run(id,h.summary,id,id);
  f.db.prepare('INSERT INTO harvests(capture_id,version,result,created_at) VALUES(?,1,?,0)').run(id,JSON.stringify(h));
 }
 let queries = 0;
 const prepare = f.env.DB.prepare.bind(f.env.DB);
 f.env.DB.prepare = sql => { queries++; return prepare(sql); };
 const start = performance.now();
 await generateProposals(f.env,{idempotency_key:'benchmark-discovery'},async () => graphResponse({},{proposals:[]}));
 console.log(JSON.stringify({records:size,queries,milliseconds:Math.round(performance.now()-start)},null,2));
} finally { await f.close(); }
