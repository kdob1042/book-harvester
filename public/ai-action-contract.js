// Shared by the browser and Worker: only requests that start AI work belong here.
export function describeAIAction(path, method = 'GET') {
  method = method.toUpperCase();
  path = path.split('?')[0];
  if (method === 'POST') {
    if (/^\/api\/themes\/[^/]+\/drilldown$/.test(path)) return {label:'深掘り', mode:'inline'};
    if (/^\/api\/themes\/[^/]+\/relationships$/.test(path)) return {label:'統合候補の探索', mode:'inline'};
    if (path === '/api/book/integration-proposals') return {label:'統合候補の探索', mode:'inline'};
    if (path === '/api/book/integration-proposals/execute') return {label:'まとめて統合', mode:'inline'};
    if (/^\/api\/captures\/[^/]+\/extract$/.test(path)) return {label:'知見の抽出', mode:'queued'};
    if (/^\/api\/imports\/[^/]+\/extract$/.test(path)) return {label:'資料からの抽出', mode:'queued'};
    if (path === '/api/book/discover') return {label:'関連の探索', mode:'inline'};
    if (path === '/api/book/integrate') return {label:'統合', mode:'inline'};
    if (/^\/api\/captures\/[^/]+\/ask$/.test(path)) return {label:'回答の作成', mode:'inline'};
    if (path === '/api/theme-changes') return {label:'問いの整理', mode:'inline'};
    if (path === '/api/graph/rebuild') return {label:'つながりの再構成', mode:'queued'};
    if (path === '/api/concept-edits') return {label:'概念の整理', mode:'inline'};
    if (/^\/api\/themes\/[^/]+\/rebuild$/.test(path)) return {label:'理解の更新', mode:'queued'};
    if (path === '/api/research' || /^\/api\/research\/[^/]+\/retry$/.test(path)) return {label:'調査', mode:'queued'};
    if (/^\/api\/captures\/[^/]+\/retry$/.test(path)) return {label:'読み取り', mode:'queued'};
    if (path === '/api/captures' || /^\/api\/captures\/[^/]+\/assets$/.test(path)) return {label:'保存・読み取り', mode:'ingestion'};
    if (/^\/api\/imports\/[^/]+\/(select|retry)$/.test(path)) return {label:'資料からの抽出', mode:'queued'};
    if (path === '/api/imports') return {label:'取り込み・読み取り', mode:'ingestion'};
  }
  if (method === 'PATCH' && /^\/api\/captures\/[^/]+$/.test(path)) return {label:'保存・読み取り', mode:'ingestion'};
  return null;
}
export const isActiveOperation = state => ['running','queued','blocked','starting','stopping','unknown'].includes(state);
