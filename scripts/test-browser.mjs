import {execFileSync, spawnSync} from 'node:child_process';

const suites = {
 auth: 'auth-browser-smoke.mjs',
 capture: 'browser-smoke.mjs',
 expansion: 'expansion-smoke.mjs',
 ideas: 'ideas-smoke.mjs',
 themes: 'theme-browser-smoke.mjs',
 discovery: 'discovery-browser-smoke.mjs',
 explicit: 'explicit-browser-smoke.mjs',
 drilldown: 'drilldown-browser-smoke.mjs',
 connections: 'connections-browser-smoke.mjs',
 proposals: 'integration-proposals-browser-smoke.mjs'
};
const featureSuites = {
 'src/auth.ts': ['auth'],
 'src/ideas.ts': ['ideas'],
 'src/themes.ts': ['themes','discovery','drilldown','proposals'],
 'src/discovery.ts': ['discovery','themes','proposals'],
 'src/classification.js': ['discovery','proposals'],
 'src/knowledge-materials.ts': ['discovery','themes','drilldown','proposals'],
 'src/integration-proposals.ts': ['proposals'],
 'src/drilldown.ts': ['drilldown'],
 'src/question-relations.ts': ['themes','connections'],
 'public/question-tree.js': ['themes','drilldown','connections','proposals']
};
const base = process.env.BROWSER_TEST_BASE;
let selected = Object.keys(suites);
if (base) {
 // A missing base must fail visibly; it must never silently skip coverage.
 const paths = execFileSync('git', ['diff','--name-only',base,'HEAD'], {encoding:'utf8'})
  .trim().split('\n').filter(Boolean);
 const needed = new Set();
 for (const path of paths) {
  if (featureSuites[path]) for (const suite of featureSuites[path]) needed.add(suite);
  else if (path.startsWith('public/connections-') || path === 'public/connections.css') needed.add('connections');
  else if (path.startsWith('scripts/') && Object.values(suites).includes(path.slice(8))) {
   needed.add(Object.keys(suites).find(key => suites[key] === path.slice(8)));
  } else if (path === 'test/helpers.js' || /^(src\/|public\/|migrations\/|scripts\/|\.github\/)/.test(path)
   || /^(package.*\.json|tsconfig\.json|wrangler.*|worker-configuration\.d\.ts)$/.test(path)) {
   for (const suite of selected) needed.add(suite);
  }
 }
 selected = selected.filter(suite => needed.has(suite));
}
if (process.argv.includes('--list')) {
 console.log(selected.join(' '));
} else {
 console.log(`Browser suites: ${selected.join(', ') || 'none (no affected browser code)'}`);
 for (const suite of selected) {
  const result = spawnSync(process.execPath, [`scripts/${suites[suite]}`], {stdio:'inherit',env:process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
 }
}
