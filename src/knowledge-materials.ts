import {questionContext} from './question-context.ts';
import {stmt,rows,fail,digest,type Harvest} from './core.ts';

export type Material={question?:ReturnType<typeof questionContext>;kind?:string;revision_id?:string;dependencies?:Material[];id:string;version:number;text:string;title:string;domain_ids:string[];lens_ids:string[];fingerprint:string;harvest:string;near?:boolean;relation?:string;reason?:string;search_direction?:string;linked?:boolean};
type LegacyClassification = {domains:Map<string,string[]>;lenses:Map<string,string[]>};
export async function material(env:Env, c:any, legacy?:LegacyClassification):Promise<Material> {
 const harvest = c.harvest as Harvest;
 const legacyDomains = harvest.classification ? [] : legacy ? legacy.domains.get(c.id) || []
  : (await rows<{domain_id:string}>(env,`SELECT DISTINCT d.domain_id FROM current_theme_memberships m
    JOIN theme_domains d ON d.theme_id=m.theme_id WHERE m.capture_id=?`,c.id)).map(d => d.domain_id);
 const legacyLenses = harvest.classification ? [] : legacy ? legacy.lenses.get(c.id) || []
  : (await rows<{lens_id:string}>(env,'SELECT DISTINCT lens_id FROM theme_member_lenses WHERE capture_id=?',c.id))
   .map(l => l.lens_id);
 const original = c.corrected_text ?? harvest.extracted_text ?? c.original_text;
 return {
  id:c.id,version:c.version,
  text:[original,c.note,harvest.summary,...harvest.claims.map(x => x.text),
   ...harvest.concepts.map(x => x.name),...harvest.questions.map(x => x.text)].join('\n'),
  title:harvest.summary || c.original_text || '記録',
  domain_ids:harvest.classification?.domain_ids || legacyDomains,
  lens_ids:harvest.classification?.lens_ids || legacyLenses,
  fingerprint:await digest(original.normalize('NFKC').replace(/\s+/g,' ').trim()),
  harvest:JSON.stringify(harvest)
 };
}
// Pages use keyset pagination, so old records remain searchable as history grows.
export async function* capturePages(env: Env, excludeId = '') {
 let cursor = '';
 while (true) {
  const page = await rows<any>(env, `SELECT c.id,c.version,c.original_text,c.corrected_text,c.note,h.result
   FROM captures c JOIN harvests h ON h.capture_id=c.id AND h.version=c.version
   WHERE c.id>? AND c.id<>? AND NOT EXISTS
    (SELECT 1 FROM capture_visibility v WHERE v.capture_id=c.id AND v.hidden=1)
   ORDER BY c.id LIMIT 200`, cursor, excludeId);
  if (!page.length) return;
  yield await captureMaterials(env, page);
  cursor = page.at(-1).id;
 }
}

// Legacy classifications are fetched for a whole page, never once per record.
export async function captureMaterials(env: Env, captures: any[]): Promise<Material[]> {
 const parsed = captures.map(c => ({...c, harvest: c.harvest || JSON.parse(c.result)}));
 const ids = parsed.filter(c => !c.harvest.classification).map(c => c.id);
 const legacy = {domains: new Map<string,string[]>(), lenses: new Map<string,string[]>()};
 if (ids.length) {
  const [domains, lenses] = await Promise.all([
   rows<{capture_id:string;domain_id:string}>(env, `SELECT DISTINCT m.capture_id,d.domain_id
    FROM current_theme_memberships m JOIN theme_domains d ON d.theme_id=m.theme_id
    WHERE m.capture_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)),
   rows<{capture_id:string;lens_id:string}>(env, `SELECT DISTINCT capture_id,lens_id
    FROM theme_member_lenses WHERE capture_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
  ]);
  for (const d of domains) legacy.domains.set(d.capture_id, [...legacy.domains.get(d.capture_id)||[], d.domain_id]);
  for (const l of lenses) legacy.lenses.set(l.capture_id, [...legacy.lenses.get(l.capture_id)||[], l.lens_id]);
 }
 return Promise.all(parsed.map(c => material(env, c, legacy)));
}

export async function themeMaterial(env:Env, themeId:string):Promise<Material> {
 const t=await stmt(env, `SELECT t.*,s.revision_id,r.result FROM themes t
  LEFT JOIN theme_syntheses s ON s.theme_id=t.id LEFT JOIN theme_revisions r ON r.id=s.revision_id
  WHERE t.id=? AND t.state='active' AND NOT EXISTS
   (SELECT 1 FROM theme_overrides WHERE theme_id=t.id AND item_key='theme' AND action='hidden')`, themeId).first<any>();
 if(!t)fail(409,'問いが更新されています。');
 const [evidence,domains] = await Promise.all([
  rows<any>(env, `SELECT DISTINCT e.capture_id AS evidence_id,e.capture_version AS expected_version,
   c.id,c.version,c.original_text,c.corrected_text,c.note,h.result,
   EXISTS(SELECT 1 FROM theme_overrides WHERE theme_id=? AND item_key='capture:'||e.capture_id AND action='hidden') AS hidden
   FROM synthesis_evidence e LEFT JOIN captures c ON c.id=e.capture_id
   LEFT JOIN harvests h ON h.capture_id=c.id AND h.version=c.version WHERE e.revision_id=?`, themeId, t.revision_id||''),
  rows<{domain_id:string}>(env,'SELECT domain_id FROM theme_domains WHERE theme_id=?',themeId)
 ]);
 if(evidence.some(c=>!c.result||c.version!==c.expected_version||c.hidden))fail(409,'問いの根拠が変わっています。');
 return {kind:'theme',id:themeId,version:t.version,revision_id:t.revision_id||'',question:questionContext(t),
  title:t.question,text:t.question+'\n'+(t.content||'')+'\n'+(t.result||''),domain_ids:domains.map(x=>x.domain_id),
  lens_ids:[],fingerprint:await digest(themeId),harvest:'',dependencies:await captureMaterials(env,evidence)};
}
export async function current(env:Env, m:Material) {
 if (m.kind === 'theme') {
  const theme = await themeMaterial(env,m.id);
  if (theme.version !== m.version || theme.revision_id !== m.revision_id) fail(409,'問いが更新されています。');
  return theme;
 }
 const capture = await stmt(env,`SELECT c.*,h.result FROM captures c LEFT JOIN harvests h
  ON h.capture_id=c.id AND h.version=c.version WHERE c.id=?`,m.id).first<any>();
 if (capture) capture.harvest = capture.result ? JSON.parse(capture.result) : null;
 if (!capture?.harvest || capture.version !== m.version || JSON.stringify(capture.harvest) !== m.harvest)
  fail(409,'材料が更新されています。探索結果は残っています。');
 return capture;
}
