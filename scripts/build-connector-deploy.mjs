// Connector deployment can retain the existing Static Assets collection. Only changed shell
// files are embedded as an authenticated ASSETS adapter; ordinary Wrangler deploys still use public/.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
const assets=Object.fromEntries(await Promise.all(['app.js','sw.js'].map(async name=>['/'+name,await readFile(new URL('../public/'+name,import.meta.url),'utf8')])));
const entry=new URL('../src/connector.generated.ts',import.meta.url);
await writeFile(entry,`import worker from './index.ts';\nexport {BookService} from './book-service.ts';\nconst patches=${JSON.stringify(assets)} as Record<string,string>;\nexport default {...worker,async fetch(request:Parameters<typeof worker.fetch>[0],env:Env,ctx:ExecutionContext){const assets=env.ASSETS;return worker.fetch(request,{...env,ASSETS:{fetch:async (r:Request)=>{const path=new URL(r.url).pathname;return patches[path]!==undefined?new Response(patches[path],{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'}}):assets.fetch(r);}} as Fetcher},ctx);}};\n`);
const r=spawnSync('npx',['wrangler','deploy','src/connector.generated.ts','--dry-run','--env','production','--minify','--outdir','dist-connector'],{stdio:'inherit'});if(r.status)process.exit(r.status);
