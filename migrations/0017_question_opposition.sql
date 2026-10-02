CREATE TABLE question_oppositions(left_id TEXT NOT NULL REFERENCES themes(id),right_id TEXT NOT NULL REFERENCES themes(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL,CHECK(left_id<right_id),PRIMARY KEY(left_id,right_id));
CREATE INDEX question_oppositions_right ON question_oppositions(right_id);
CREATE TABLE question_relation_runs(id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL REFERENCES themes(id),anchor_version INTEGER NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE question_relation_choices(run_id TEXT NOT NULL REFERENCES question_relation_runs(id),candidate_index INTEGER NOT NULL,target_id TEXT NOT NULL REFERENCES themes(id),PRIMARY KEY(run_id,candidate_index));
CREATE VIEW canonical_question_oppositions AS
SELECT DISTINCT min(l.id,r.id) AS left_id,max(l.id,r.id) AS right_id,o.reason,o.created_at
FROM question_oppositions o JOIN canonical_question_ids l ON l.original_id=o.left_id JOIN canonical_question_ids r ON r.original_id=o.right_id WHERE l.id<>r.id;
