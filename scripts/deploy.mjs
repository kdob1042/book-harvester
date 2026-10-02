import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const production=config.env.production;
if(!production.vars.APP_ORIGIN.startsWith('https://')||production.vars.APP_ORIGIN.includes('.invalid')||production.d1_databases[0].database_id.startsWith('00000000-')){
 console.error('Set production APP_ORIGIN and the actual production D1 database_id in wrangler.jsonc.');process.exit(1);
}
for(const args of [['d1','migrations','apply','DB','--remote','--env','production'],['deploy','--env','production']]){
 const result=spawnSync('npx',['wrangler',...args],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
