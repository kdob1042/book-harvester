CREATE TABLE reading_sessions (
 id TEXT PRIMARY KEY,source_id TEXT,started_at INTEGER NOT NULL,ended_at INTEGER NOT NULL,inferred INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE reading_session_members (
 capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES reading_sessions(id) ON DELETE CASCADE,manual INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reading_session_members_session ON reading_session_members(session_id);
CREATE TABLE reflection_jobs (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,scope_key TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,
 signature TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL,dispatched_at INTEGER,lease_until INTEGER,lease_token TEXT,error_code TEXT,created_at INTEGER NOT NULL,
 UNIQUE(scope,scope_key)
);
CREATE TABLE reflections (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,scope_key TEXT NOT NULL,signature TEXT NOT NULL,result TEXT NOT NULL,
 input_json TEXT NOT NULL,model TEXT NOT NULL,processing_version TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE INDEX reflection_scope ON reflections(scope,scope_key,created_at);
CREATE TABLE revisit_state (
 capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,hidden INTEGER NOT NULL DEFAULT 0,
 last_shown_at INTEGER,shown_count INTEGER NOT NULL DEFAULT 0
);
