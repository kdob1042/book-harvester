CREATE TABLE research_runs (
 id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,
 kind TEXT NOT NULL,question TEXT NOT NULL,subject_period TEXT,capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,capture_version INTEGER,view_id TEXT,view_version INTEGER,
 urls_json TEXT NOT NULL DEFAULT '[]',result_json TEXT,model TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,available_at INTEGER NOT NULL,dispatched_at INTEGER,lease_until INTEGER,lease_token TEXT,
 ai_calls INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,finished_at INTEGER
);
CREATE INDEX research_ready ON research_runs(state,available_at);
CREATE TABLE research_materials (
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,url TEXT NOT NULL,canonical_url TEXT,content_hash TEXT,
 title TEXT,published_at TEXT,event_at TEXT,subject_period TEXT,retrieved_at INTEGER NOT NULL,
 scope TEXT NOT NULL DEFAULT 'unknown',body TEXT,state TEXT NOT NULL,error_code TEXT,capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
 UNIQUE(run_id,url)
);
CREATE TABLE external_source_index (fingerprint TEXT PRIMARY KEY,capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,deleted INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
