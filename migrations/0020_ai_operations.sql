-- Cancellation is durable and independent of the HTTP connection / Worker isolate.
CREATE TABLE ai_operations (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, label TEXT NOT NULL, mode TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','queued','completed','failed','canceled')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 workflow TEXT, target_id TEXT, stage TEXT, response_json TEXT, response_status INTEGER
);
CREATE INDEX ai_operations_active ON ai_operations(state,updated_at);
-- Idempotent inline requests also keep their original active owner across tabs.
CREATE TABLE ai_operation_requests (
 request_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
 operation_id TEXT NOT NULL REFERENCES ai_operations(id) ON DELETE CASCADE
);

CREATE TABLE ai_operation_jobs (
 kind TEXT NOT NULL, job_id TEXT NOT NULL, generation TEXT NOT NULL,
 operation_id TEXT NOT NULL REFERENCES ai_operations(id) ON DELETE CASCADE,
 PRIMARY KEY(kind,job_id,generation)
);
CREATE INDEX ai_operation_jobs_owner ON ai_operation_jobs(operation_id);
-- Each result-writing D1 transaction starts with this fence. Cancellation and
-- result commits therefore cannot interleave between a check and a later write.
CREATE TABLE ai_operation_fences (
 operation_id TEXT PRIMARY KEY REFERENCES ai_operations(id) ON DELETE CASCADE
);
CREATE TRIGGER ai_operation_fence BEFORE INSERT ON ai_operation_fences
 WHEN NOT EXISTS(SELECT 1 FROM ai_operations WHERE id=NEW.operation_id AND state IN ('running','queued'))
 BEGIN SELECT RAISE(ABORT,'ai_operation_not_active'); END;

-- A request / queue delivery may still be scheduling its next stage after its
-- current job has committed. Status polling must not finish it in that gap.
CREATE TABLE ai_operation_leases (
 token TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES ai_operations(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE INDEX ai_operation_leases_owner ON ai_operation_leases(operation_id,expires_at);

-- Original ingestion must be saved even when cancellation wins first. This
-- separate transaction-local marker assigns its queued work without requiring
-- an active AI operation. A canceled owner prevents the queued provider call.
CREATE TABLE ai_operation_registrations (
 operation_id TEXT PRIMARY KEY REFERENCES ai_operations(id) ON DELETE CASCADE
);
CREATE VIEW ai_operation_write_owners AS
 SELECT operation_id FROM ai_operation_fences UNION SELECT operation_id FROM ai_operation_registrations;

-- Track newly-created child jobs in the same fenced result transaction. No
-- cron/queue consumer can see an unowned child between save and publication.
CREATE TRIGGER ai_operation_own_capture_insert AFTER INSERT ON jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'capture',NEW.id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_capture_update AFTER UPDATE ON jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners) AND (NEW.version<>OLD.version OR (OLD.state NOT IN ('pending','running','blocked') AND NEW.state='pending'))
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'capture',NEW.id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_graph_insert AFTER INSERT ON graph_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'graph',NEW.id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_graph_update AFTER UPDATE ON graph_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners) AND (NEW.version<>OLD.version OR (OLD.state NOT IN ('pending','running','blocked') AND NEW.state='pending'))
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'graph',NEW.id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_theme_insert AFTER INSERT ON theme_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'theme',NEW.id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_theme_update AFTER UPDATE ON theme_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners) AND (NEW.version<>OLD.version OR (OLD.state NOT IN ('pending','running','blocked') AND NEW.state='pending'))
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'theme',NEW.id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_research_insert AFTER INSERT ON research_runs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'research',NEW.id,CAST(NEW.created_at AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_research_update AFTER UPDATE ON research_runs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners) AND (NEW.created_at<>OLD.created_at OR (OLD.state NOT IN ('pending','running','blocked') AND NEW.state='pending'))
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'research',NEW.id,CAST(NEW.created_at AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_import_insert AFTER INSERT ON import_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'import',NEW.id,CAST(NEW.created_at AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_import_update AFTER UPDATE ON import_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners) AND (NEW.created_at<>OLD.created_at OR (OLD.state NOT IN ('pending','running','blocked') AND NEW.state='pending'))
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'import',NEW.id,CAST(NEW.created_at AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_embedding_insert AFTER INSERT ON embedding_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'embedding',NEW.capture_id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_embedding_update AFTER UPDATE ON embedding_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners) AND (NEW.version<>OLD.version OR (OLD.state NOT IN ('pending','running','blocked') AND NEW.state='pending'))
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'embedding',NEW.capture_id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_bibliography_insert AFTER INSERT ON bibliography_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'bibliography',NEW.capture_id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_bibliography_update AFTER UPDATE ON bibliography_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners) AND (NEW.version<>OLD.version OR (OLD.state NOT IN ('pending','running','blocked') AND NEW.state='pending'))
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'bibliography',NEW.capture_id,CAST(NEW.version AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_reflection_insert AFTER INSERT ON reflection_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'reflection',NEW.id,CAST(NEW.signature AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;
CREATE TRIGGER ai_operation_own_reflection_update AFTER UPDATE ON reflection_jobs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners) AND (NEW.signature<>OLD.signature OR (OLD.state NOT IN ('pending','running','blocked') AND NEW.state='pending'))
 BEGIN
  INSERT INTO ai_operation_jobs(kind,job_id,generation,operation_id)
  SELECT 'reflection',NEW.id,CAST(NEW.signature AS TEXT),operation_id FROM ai_operation_write_owners WHERE 1
  ON CONFLICT(kind,job_id,generation) DO UPDATE SET operation_id=excluded.operation_id
  WHERE EXISTS(SELECT 1 FROM ai_operations WHERE id=ai_operation_jobs.operation_id AND state IN ('completed','failed','canceled'));
 END;

-- Terminal cleanup must not depend on the original request surviving long enough
-- to run its catch block. Retain exactly which inline attempt belongs to a stop.
CREATE TABLE ai_operation_records (
 kind TEXT NOT NULL, record_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
 operation_id TEXT NOT NULL REFERENCES ai_operations(id) ON DELETE CASCADE,
 PRIMARY KEY(kind,record_id,attempt)
);
CREATE INDEX ai_operation_records_owner ON ai_operation_records(operation_id);
CREATE TRIGGER ai_operation_own_discovery_record AFTER INSERT ON discovery_runs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN INSERT OR IGNORE INTO ai_operation_records(kind,record_id,operation_id)
 SELECT 'discovery',NEW.id,operation_id FROM ai_operation_write_owners; END;
CREATE TRIGGER ai_operation_own_integration_record AFTER INSERT ON integration_runs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN INSERT OR IGNORE INTO ai_operation_records(kind,record_id,operation_id)
 SELECT 'integration',NEW.id,operation_id FROM ai_operation_write_owners; END;
CREATE TRIGGER ai_operation_own_proposals_record AFTER INSERT ON integration_proposal_runs
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN INSERT OR IGNORE INTO ai_operation_records(kind,record_id,operation_id)
 SELECT 'proposals',NEW.id,operation_id FROM ai_operation_write_owners; END;
CREATE TRIGGER ai_operation_own_proposal_attempt AFTER UPDATE ON integration_proposals
 WHEN NEW.state='running' AND NEW.attempt<>OLD.attempt AND EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN INSERT OR IGNORE INTO ai_operation_records(kind,record_id,attempt,operation_id)
 SELECT 'proposal',NEW.id,NEW.attempt,operation_id FROM ai_operation_write_owners; END;
CREATE TRIGGER ai_operation_own_book_receipt AFTER INSERT ON book_operation_receipts
 WHEN EXISTS(SELECT 1 FROM ai_operation_write_owners)
 BEGIN INSERT OR IGNORE INTO ai_operation_records(kind,record_id,operation_id)
 SELECT 'receipt',NEW.operation_key,operation_id FROM ai_operation_write_owners; END;

-- Current-generation state for atomic queued completion and snapshot checks.
-- workerd permits at most five terms in a compound SELECT. Resolve each owned
-- job through its indexed table instead of an eight-term UNION ALL.
CREATE VIEW ai_operation_job_states AS
SELECT l.operation_id,l.kind,l.job_id,l.generation,
 CASE l.kind WHEN 'capture' THEN c.state WHEN 'graph' THEN g.state
  WHEN 'theme' THEN t.state WHEN 'research' THEN r.state WHEN 'import' THEN i.state
  WHEN 'embedding' THEN e.state WHEN 'bibliography' THEN b.state WHEN 'reflection' THEN f.state END AS state,
 CASE l.kind WHEN 'capture' THEN 'extract' WHEN 'graph' THEN 'graph'
  WHEN 'theme' THEN t.kind WHEN 'import' THEN 'extract_import' END AS action_kind,
 CASE l.kind WHEN 'capture' THEN c.capture_id WHEN 'graph' THEN g.capture_id
  WHEN 'theme' THEN t.target_id WHEN 'import' THEN i.id
  WHEN 'embedding' THEN e.capture_id WHEN 'bibliography' THEN b.capture_id END AS target_id
FROM ai_operation_jobs l
LEFT JOIN jobs c ON l.kind='capture' AND l.job_id=c.id AND l.generation=CAST(c.version AS TEXT)
LEFT JOIN graph_jobs g ON l.kind='graph' AND l.job_id=g.id AND l.generation=CAST(g.version AS TEXT)
LEFT JOIN theme_jobs t ON l.kind='theme' AND l.job_id=t.id AND l.generation=CAST(t.version AS TEXT)
LEFT JOIN research_runs r ON l.kind='research' AND l.job_id=r.id AND l.generation=CAST(r.created_at AS TEXT)
LEFT JOIN import_jobs i ON l.kind='import' AND l.job_id=i.id AND l.generation=CAST(i.created_at AS TEXT)
LEFT JOIN embedding_jobs e ON l.kind='embedding' AND l.job_id=e.capture_id AND l.generation=CAST(e.version AS TEXT)
LEFT JOIN bibliography_jobs b ON l.kind='bibliography' AND l.job_id=b.capture_id AND l.generation=CAST(b.version AS TEXT)
LEFT JOIN reflection_jobs f ON l.kind='reflection' AND l.job_id=f.id AND l.generation=CAST(f.signature AS TEXT)
WHERE coalesce(c.id,g.id,t.id,r.id,i.id,e.capture_id,b.capture_id,f.id) IS NOT NULL;
