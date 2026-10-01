PRAGMA foreign_keys=ON;
CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE login_limits (address TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, title TEXT NOT NULL UNIQUE, certainty TEXT NOT NULL, published_at TEXT, subject_period TEXT, created_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE captures (
 id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL,
 source_id TEXT REFERENCES sources(id), source_inherited INTEGER NOT NULL DEFAULT 0,
 kind TEXT NOT NULL, original_text TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', corrected_text TEXT,
 page TEXT, chapter TEXT, locator_certainty TEXT NOT NULL DEFAULT 'unknown', source_locked INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1, mutation_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE capture_revisions (
 capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 corrected_text TEXT, note TEXT NOT NULL, source_id TEXT, page TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(capture_id, version)
);
CREATE TABLE assets (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
 object_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
 request_key TEXT UNIQUE, request_hash TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE staged_uploads (object_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE asset_transcripts (
 asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE object_deletions (object_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL, dispatched_at INTEGER, lease_until INTEGER, lease_token TEXT, error_code TEXT,
 model TEXT, prompt_version TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 transcript TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, UNIQUE(capture_id, version)
);
CREATE INDEX jobs_ready ON jobs(state, available_at, dispatched_at);
CREATE TABLE harvests (
 capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(capture_id, version)
);
CREATE TABLE answers (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, question TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE views (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
 draft_key TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE view_revisions (
 view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 body TEXT NOT NULL, reason TEXT NOT NULL, references_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(view_id, version)
);
CREATE TABLE ai_daily (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);
CREATE TABLE ai_calls (
 id TEXT PRIMARY KEY, capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
 day TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL,
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
