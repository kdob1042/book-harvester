// A question may have several parents. Expand each shared subtree only once.
export function questionTree(index, escape) {
 const themes = index.themes || [];
 const byId = new Map(themes.map(t => [t.id, t]));
 const children = new Map();
 for (const edge of index.branches || []) {
  if (!byId.has(edge.parent_id) || !byId.has(edge.child_id)) continue;
  if (!children.has(edge.parent_id)) children.set(edge.parent_id, new Set());
  children.get(edge.parent_id).add(edge.child_id);
 }
 const scores = new Map();
 const score = id => {
  if (scores.has(id)) return scores.get(id);
  const seen = new Set(), pending = [id];
  let total = 0;
  while (pending.length) {
   const next = pending.pop();
   if (seen.has(next)) continue;
   seen.add(next);
   total += Number(byId.get(next).integration_count || 0);
   for (const child of children.get(next) || []) pending.push(child);
  }
  scores.set(id, total);
  return total;
 };
 const sorted = ids => [...ids].sort((a, b) => score(b) - score(a)
  || Number(byId.get(b).updated_at || 0) - Number(byId.get(a).updated_at || 0)
  || a.localeCompare(b));
 const expanded = new Set(), html = [];
 const pending = sorted(themes.filter(t => t.is_tip !== 0).map(t => t.id))
  .reverse().map(id => ({id}));
 // Iterative traversal avoids overflowing the call stack on deep histories.
 while (pending.length) {
  const item = pending.pop();
  if (item.close) { html.push(item.close); continue; }
  const theme = byId.get(item.id);
  html.push(`<li><button class="capture-row theme-row" data-theme="${escape(theme.id)}"><h2>${escape(theme.question)}</h2></button>`);
  const branches = expanded.has(theme.id) ? [] : sorted(children.get(theme.id) || []);
  expanded.add(theme.id);
  if (branches.length) {
   html.push('<ul class="question-branches">');
   pending.push({close: '</ul></li>'});
   for (const id of branches.reverse()) pending.push({id});
  } else html.push('</li>');
 }
 return html.join('');
}
