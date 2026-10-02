CREATE TABLE question_relations(parent_id TEXT NOT NULL REFERENCES themes(id),child_id TEXT NOT NULL REFERENCES themes(id),type TEXT NOT NULL CHECK(type='drilldown'),created_at INTEGER NOT NULL,PRIMARY KEY(parent_id,child_id,type));
CREATE INDEX question_relations_child ON question_relations(child_id);
CREATE TABLE drilldown_runs(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES themes(id),parent_version INTEGER NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE drilldown_choices(run_id TEXT NOT NULL REFERENCES drilldown_runs(id),candidate_index INTEGER NOT NULL,child_id TEXT NOT NULL REFERENCES themes(id),PRIMARY KEY(run_id,candidate_index));
