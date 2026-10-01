ALTER TABLE captures ADD COLUMN import_origin TEXT;
ALTER TABLE captures ADD COLUMN source_locator TEXT;
ALTER TABLE sources ADD COLUMN bibliography_json TEXT;
CREATE TABLE import_jobs (
 id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,
 format TEXT NOT NULL,name TEXT NOT NULL,object_key TEXT,mime TEXT,size INTEGER,
 state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,
 metadata_json TEXT NOT NULL DEFAULT '{}',available_at INTEGER NOT NULL,dispatched_at INTEGER,lease_token TEXT,lease_until INTEGER,created_at INTEGER NOT NULL
);
CREATE TABLE import_items (
 id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL,locator TEXT,origin TEXT NOT NULL DEFAULT 'source',body TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',
 object_key TEXT,mime TEXT,size INTEGER,capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
 state TEXT NOT NULL DEFAULT 'available',error_code TEXT,selected INTEGER NOT NULL DEFAULT 0,
 UNIQUE(job_id,ordinal)
);
CREATE INDEX imports_ready ON import_jobs(state,available_at);
CREATE TABLE bibliography_jobs (
 capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,version INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,available_at INTEGER NOT NULL,dispatched_at INTEGER,lease_until INTEGER,lease_token TEXT
);
CREATE UNIQUE INDEX imports_fingerprint ON import_jobs(request_hash);
CREATE TABLE bibliography_cache (query TEXT PRIMARY KEY,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);
ALTER TABLE import_items ADD COLUMN display_order INTEGER;
