INSERT OR IGNORE INTO domains VALUES('technology','技術・インフラ','計算資源、通信、電力、技術の性能と制約',6);
CREATE TABLE discovery_runs(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,anchor_id TEXT NOT NULL,anchor_version INTEGER NOT NULL,state TEXT NOT NULL,input_json TEXT NOT NULL,result_json TEXT,error TEXT,created_at INTEGER NOT NULL);
CREATE INDEX discovery_anchor ON discovery_runs(anchor_id,anchor_version,created_at);
CREATE TABLE integration_runs(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,discovery_id TEXT NOT NULL REFERENCES discovery_runs(id),state TEXT NOT NULL,input_json TEXT NOT NULL,result_json TEXT,error TEXT,created_at INTEGER NOT NULL);
