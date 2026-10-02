// Read-only projection. An edge exists only when a saved relationship says it does.
export const CARD = { width: 216, height: 86, gapX: 32, gapY: 58 };
export const keyFor = (kind, id) => `${kind}:${id}`;
const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value : '';
const normalized = value => string(value).normalize('NFKC').toLocaleLowerCase('ja');

export function buildConnections(index, details = new Map(), captures = new Map()) {
  const nodes = new Map(), edges = new Map();
  const addEdge = edge => {
    if (edge.from === edge.to || !nodes.has(edge.from) || !nodes.has(edge.to)) return;
    edges.set(`${edge.kind}:${edge.from}:${edge.to}`, edge);
  };
  for (const theme of list(index?.themes)) {
    if (!theme?.id || (theme.state && theme.state !== 'active') || theme.hidden) continue;
    const id = keyFor('theme', theme.id);
    nodes.set(id, { id, entityId: theme.id, kind: 'theme', title: string(theme.question) || '問い',
      content: string(theme.content), count: Number(theme.integration_count) || 0,
      materials: Number(theme.material_count) || 0, stale: Boolean(theme.stale), data: theme });
  }
  for (const branch of list(index?.branches)) {
    const parent = details.get(branch.parent_id), child = details.get(branch.child_id);
    const input = list(parent?.children).some(c => c.child_kind === 'theme' && c.child_id === branch.child_id) ||
      list(child?.parents).some(p => p.id === branch.parent_id);
    const drilldown = list(parent?.drilldown_children).some(c => c.id === branch.child_id) ||
      list(child?.drilldown_parents).some(p => p.id === branch.parent_id);
    const endpoints = { from: keyFor('theme', branch.parent_id), to: keyFor('theme', branch.child_id) };
    // The index intentionally combines both kinds without a type. Do not call
    // an unknown parent/child link an integration until a detail confirms it.
    if (input) addEdge({ ...endpoints, kind: 'input' });
    if (drilldown) addEdge({ ...endpoints, kind: 'drilldown' });
    if (!input && !drilldown) addEdge({ ...endpoints, kind: 'hierarchy' });
  }
  for (const pair of list(index?.oppositions)) addEdge({from:keyFor('theme',pair.left_id),to:keyFor('theme',pair.right_id),kind:'opposes'});
  for (const [themeId, detail] of details) {
    const parent = keyFor('theme', themeId);
    if (!nodes.has(parent) || !detail?.theme || detail.redirect) continue;
    nodes.get(parent).stale = Boolean(detail.stale);
    const children = list(detail.children);
    // Current memberships already enforce version and local visibility guards.
    // Never resurrect a removed/hidden record from a historical child snapshot.
    for (const member of list(detail.materials)) {
      if (!member?.capture_id || member.hidden) continue;
      const capture = captures.get(member.capture_id);
      if (capture?.unavailable || capture?.hidden) continue;
      const currentVersion = Number(member.capture_version);
      if (capture && Number(capture.version) !== currentVersion) continue;
      const child = children.find(c => c.child_kind === 'capture' && c.child_id === member.capture_id &&
        Number(c.child_version) === currentVersion);
      const id = keyFor('capture', member.capture_id);
      nodes.set(id, { id, entityId: member.capture_id, kind: 'capture',
        title: string(capture?.harvest?.summary) || string(child?.title) || '記録',
        content: string(capture?.note), count: 0, version: currentVersion,
        data: capture || member });
      addEdge({ from: parent, to: id, kind: child ? 'input' : 'material',
        reason: string(member.reason), stale: Boolean(detail.stale) });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// Search is local: no semantic search, inference, embeddings or write requests.
// Preserve matches and their immediate neighbours, not an implied new hierarchy.
export function visibleConnections(graph, query = '', selected = null, limit = 300) {
  limit = Math.max(1, Math.floor(Number(limit)) || 300);
  const term = normalized(query).trim(), all = new Map(graph.nodes.map(n => [n.id, n]));
  const matched = new Set(graph.nodes.filter(n => normalized(`${n.title}\n${n.content || ''}`).includes(term)).map(n => n.id));
  const wanted = term ? new Set(matched) : new Set(all.keys());
  if (term) for (const edge of graph.edges) {
    if (matched.has(edge.from)) wanted.add(edge.to);
    if (matched.has(edge.to)) wanted.add(edge.from);
  }
  const candidates = graph.nodes.filter(n => wanted.has(n.id));
  const priority = n => (n.id === selected ? 1e9 : 0) + (term && matched.has(n.id) ? 1e8 : 0) + n.count;
  const retained = candidates.sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id)).slice(0, limit);
  const ids = new Set(retained.map(n => n.id));
  return { nodes: retained, edges: graph.edges.filter(e => ids.has(e.from) && ids.has(e.to)),
    total: graph.nodes.length, eligible: candidates.length, matched, truncated: candidates.length > limit };
}

// Iterative layered layout: unequal-depth inputs may skip rows. Shared inputs
// remain one node. Cycles and very deep histories cannot recurse indefinitely.
export function layoutConnections(graph) {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const parents = new Map(), children = new Map(), neighbours = new Map();
  for (const id of nodes.keys()) { parents.set(id, new Set()); children.set(id, new Set()); neighbours.set(id, new Set()); }
  for (const e of graph.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to) continue;
    if(e.kind!=='opposes'){children.get(e.from).add(e.to); parents.get(e.to).add(e.from);}
    neighbours.get(e.from).add(e.to); neighbours.get(e.to).add(e.from);
  }
  const pending = new Map([...children].map(([id, c]) => [id, c.size])), rank = new Map();
  const queue = [...nodes.keys()].filter(id => pending.get(id) === 0).sort();
  for (const id of queue) rank.set(id, 0);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    for (const parent of parents.get(id)) {
      rank.set(parent, Math.max(rank.get(parent) || 0, rank.get(id) + 1));
      pending.set(parent, pending.get(parent) - 1);
      if (!pending.get(parent)) queue.push(parent);
    }
  }
  const cyclic = new Set([...nodes.keys()].filter(id => pending.get(id) > 0));
  for (const id of cyclic) rank.set(id, 0);
  const visited = new Set(), components = [];
  const ordered = [...nodes.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  for (const node of ordered) {
    if (visited.has(node.id)) continue;
    const component = [node.id]; visited.add(node.id);
    for (let cursor = 0; cursor < component.length; cursor++) for (const id of neighbours.get(component[cursor])) {
      if (!visited.has(id)) { visited.add(id); component.push(id); }
    }
    components.push(component);
  }
  const positions = new Map();
  let left = 0, top = 0, shelfHeight = 0, width = 0, height = 0;
  for (const component of components) {
    const levels = new Map();
    for (const id of component) { const r = rank.get(id) || 0; if (!levels.has(r)) levels.set(r, []); levels.get(r).push(id); }
    const ranks = [...levels.keys()].sort((a, b) => b - a);
    const maxRank = ranks[0] || 0, columns = Math.max(...[...levels.values()].map(row => row.length));
    const w = columns * (CARD.width + CARD.gapX) - CARD.gapX;
    const h = (maxRank + 1) * (CARD.height + CARD.gapY) - CARD.gapY;
    if (left && left + w > 1440) { left = 0; top += shelfHeight + 90; shelfHeight = 0; }
    for (const r of ranks) {
      const row = levels.get(r);
      const barycentre = id => {
        const xs = [...parents.get(id)].map(p => positions.get(p)?.x).filter(x => x !== undefined);
        return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : Infinity;
      };
      row.sort((a, b) => barycentre(a) - barycentre(b) || nodes.get(b).count - nodes.get(a).count || a.localeCompare(b));
      row.forEach((id, i) => positions.set(id, {
        x: left + (columns - row.length) * (CARD.width + CARD.gapX) / 2 + i * (CARD.width + CARD.gapX),
        y: top + (maxRank - r) * (CARD.height + CARD.gapY),
      }));
    }
    width = Math.max(width, left + w); height = Math.max(height, top + h);
    left += w + 90; shelfHeight = Math.max(shelfHeight, h);
  }
  return { positions, width: Math.max(width, CARD.width), height: Math.max(height, CARD.height), cyclic };
}

export function labelLines(value, maxUnits = 27, maxLines = 2) {
  const lines = ['']; let units = 0;
  for (const char of string(value).replace(/\s+/g, ' ')) {
    const size = /[\u0000-\u007f]/.test(char) ? 1 : 2;
    if (units + size > maxUnits) {
      if (lines.length >= maxLines) { lines[lines.length - 1] += '…'; break; }
      lines.push(''); units = 0;
    }
    lines[lines.length - 1] += char; units += size;
  }
  return lines;
}
