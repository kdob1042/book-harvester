-- Cancellation is durable and independent of the HTTP connection / Worker isolate.
CREATE TABLE ai_operations (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, label TEXT NOT NULL, mode TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','queued','completed','failed','canceled')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ai_operations_active ON ai_operations(state,updated_at);
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
