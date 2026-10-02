-- Keep integration evidence snapshots, but exclude deleted questions from the live hierarchy.
DROP VIEW canonical_question_edges;
CREATE VIEW canonical_question_edges AS
SELECT DISTINCT p.id AS parent_id,c.id AS child_id FROM (
 SELECT parent_id,child_id FROM question_relations
 UNION SELECT k.parent_id,k.child_id FROM knowledge_inputs k JOIN theme_syntheses s ON s.revision_id=k.parent_revision WHERE k.child_kind='theme'
) e JOIN canonical_question_ids p ON p.original_id=e.parent_id
JOIN canonical_question_ids c ON c.original_id=e.child_id
JOIN themes pt ON pt.id=p.id JOIN themes ct ON ct.id=c.id
WHERE p.id<>c.id AND pt.state<>'deleted' AND ct.state<>'deleted';
