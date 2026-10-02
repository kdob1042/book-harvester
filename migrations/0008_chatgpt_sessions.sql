-- OAuth credentials are AES-GCM encrypted with a key held only in Worker secrets.
-- Intentionally excluded from record export/sync.
CREATE TABLE chatgpt_sessions (
 id TEXT PRIMARY KEY,
 encrypted TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'connected',
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0
);
