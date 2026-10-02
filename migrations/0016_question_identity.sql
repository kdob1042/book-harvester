-- Resolve stable source IDs through any later identity merges.
CREATE VIEW canonical_question_ids AS
WITH RECURSIVE links(original_id,id,next) AS (
 SELECT id,id,merged_into FROM themes
 UNION ALL SELECT links.original_id,t.id,t.merged_into FROM links JOIN themes t ON t.id=links.next
) SELECT original_id,id FROM links WHERE next IS NULL;
CREATE VIEW canonical_question_edges AS
SELECT DISTINCT p.id AS parent_id,c.id AS child_id FROM (
 SELECT parent_id,child_id FROM question_relations
 UNION SELECT k.parent_id,k.child_id FROM knowledge_inputs k JOIN theme_syntheses s ON s.revision_id=k.parent_revision WHERE k.child_kind='theme'
) e JOIN canonical_question_ids p ON p.original_id=e.parent_id JOIN canonical_question_ids c ON c.original_id=e.child_id WHERE p.id<>c.id;
