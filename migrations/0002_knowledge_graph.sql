-- Adopted text and its snapshots outlive the source Capture. Deleting a source is not a View edit.
CREATE TABLE views_preserved (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, draft_key TEXT UNIQUE NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL
);
INSERT INTO views_preserved SELECT * FROM views;
CREATE TABLE preserved_view_revisions AS SELECT * FROM view_revisions;
DROP TABLE view_revisions;
DROP TABLE views;
ALTER TABLE views_preserved RENAME TO views;
CREATE TABLE view_revisions (
 view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 body TEXT NOT NULL, reason TEXT NOT NULL, references_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(view_id,version)
);
INSERT INTO view_revisions SELECT * FROM preserved_view_revisions;
DROP TABLE preserved_view_revisions;
CREATE TABLE graph_jobs (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
 dispatched_at INTEGER, lease_until INTEGER, lease_token TEXT, error_code TEXT, created_at INTEGER NOT NULL,
 UNIQUE(capture_id,version)
);
CREATE INDEX graph_jobs_ready ON graph_jobs(state,available_at,dispatched_at);
CREATE TABLE graph_generations (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL, model TEXT NOT NULL, processing_version TEXT NOT NULL,
 input_snapshot TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_active_graph ON graph_generations(capture_id,version) WHERE active=1;
CREATE TABLE graph_nodes (
 id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES graph_generations(id) ON DELETE CASCADE,
 local_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('claim','concept','question','mechanism')),
 text TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX graph_node_kind ON graph_nodes(kind);
CREATE TABLE concepts (id TEXT PRIMARY KEY,name TEXT NOT NULL,meaning TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE concept_mentions (
 node_id TEXT PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE, concept_id TEXT NOT NULL REFERENCES concepts(id),
 decision TEXT NOT NULL, reason TEXT NOT NULL, aliases TEXT NOT NULL
);
CREATE TABLE graph_relations (
 id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES graph_generations(id) ON DELETE CASCADE,
 from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE graph_dependencies (
 generation_id TEXT NOT NULL REFERENCES graph_generations(id) ON DELETE CASCADE,
 capture_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(generation_id,capture_id)
);
CREATE TABLE view_proposals (
 id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES graph_generations(id) ON DELETE CASCADE,
 view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE, base_version INTEGER NOT NULL,
 from_text TEXT NOT NULL,to_text TEXT NOT NULL,reason TEXT NOT NULL,references_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
);
CREATE TABLE graph_overrides (
 capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE, item_key TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN('hidden','adopted')), created_at INTEGER NOT NULL,
 PRIMARY KEY(capture_id,item_key)
);
CREATE VIEW current_graph_generations AS
 SELECT g.* FROM graph_generations g JOIN captures c ON c.id=g.capture_id AND c.version=g.version
 WHERE g.active=1 AND NOT EXISTS(
  SELECT 1 FROM graph_dependencies d LEFT JOIN captures x ON x.id=d.capture_id
  WHERE d.generation_id=g.id AND (x.id IS NULL OR x.version<>d.version)
 );
CREATE VIEW current_graph_nodes AS
 SELECT n.*,g.capture_id,g.version FROM graph_nodes n JOIN graph_generations g ON g.id=n.generation_id
 JOIN captures c ON c.id=g.capture_id AND c.version=g.version WHERE g.active=1
 AND (n.kind<>'mechanism' OR EXISTS(SELECT 1 FROM current_graph_generations WHERE id=g.id));
CREATE VIEW current_graph_relations AS
 SELECT r.*,g.capture_id,g.version FROM graph_relations r JOIN current_graph_generations g ON g.id=r.generation_id
 WHERE EXISTS(SELECT 1 FROM current_graph_nodes WHERE id=r.from_id)
 AND EXISTS(SELECT 1 FROM current_graph_nodes WHERE id=r.to_id);
-- Existing captures enter the graph automatically; no new parse/approval action is needed.
INSERT INTO graph_jobs(id,capture_id,version,available_at,created_at)
 SELECT lower(hex(randomblob(16))),h.capture_id,h.version,0,h.created_at FROM harvests h JOIN captures c ON c.id=h.capture_id AND c.version=h.version;
