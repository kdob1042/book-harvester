export const toolSpecs = [
 ['get_status','Read implementation capabilities and processing status','book:read',{}],
 ['search_records','Search all saved records without AI. Cursor pagination covers the entire history.','book:read',{query:{type:'string'},cursor:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}}],
 ['get_record','Read a record, evidence, and graph','book:read',{id:{type:'string'}}],
 ['save_capture','Save the specified text with optional source; starts the existing ingestion pipeline','book:write',{text:{type:'string'},source:{type:'string'},note:{type:'string'},idempotency_key:{type:'string'}}],
 ['revise_capture','Correct a record at its expected version','book:write',{id:{type:'string'},version:{type:'integer'},corrected_text:{type:'string'},note:{type:'string'},idempotency_key:{type:'string'}}],
 ['adopt_view','Explicitly adopt the record AI draft as the user view','book:write',{id:{type:'string'},version:{type:'integer'},idempotency_key:{type:'string'}}],
 ['get_view','Read a user view and adoption history','book:read',{id:{type:'string'}}],
 ['revise_view','Explicitly edit a user view','book:write',{id:{type:'string'},version:{type:'integer'},body:{type:'string'},reason:{type:'string'},idempotency_key:{type:'string'}}],
 ['get_relations','Read the saved local graph without AI','book:read',{id:{type:'string'}}],
 ['get_job','Read ingestion or research job status','book:read',{id:{type:'string'},kind:{type:'string',enum:['capture','research']}}],
 ['retry_job','Explicitly retry failed ingestion or research','book:write',{id:{type:'string'},version:{type:'integer'},kind:{type:'string',enum:['capture','research']},idempotency_key:{type:'string'}}],
 ['start_research','Explicitly start external research under configured host and AI limits','book:write',{question:{type:'string'},capture_id:{type:'string'},version:{type:'integer'},subject_period:{type:'string'},url:{type:'string'},idempotency_key:{type:'string'}}],
 ['cancel_job','Cancel a research job','book:write',{id:{type:'string'},idempotency_key:{type:'string'}}],
 ['preview_delete','Inspect deletion impact and obtain a short-lived version-bound confirmation','book:manage',{id:{type:'string'},version:{type:'integer'}}],
 ['delete_capture','Permanently delete the previewed record using its confirmation and expected version','book:manage',{id:{type:'string'},version:{type:'integer'},confirmation:{type:'string'},idempotency_key:{type:'string'}}],
 ['get_domains','Read knowledge domains when the theme module is available','book:read',{}],
 ['get_theme','Read theme understanding and evidence when the theme module is available','book:read',{id:{type:'string'}}],
 ['get_migration_status','Read theme migration capabilities','book:read',{}],
 ['get_theme_context','Read saved theme context without AI','book:read',{id:{type:'string'}}],
 ['get_history','Read theme synthesis revisions','book:read',{id:{type:'string'}}],
 ['revise_theme','Explicitly correct theme scope at its expected version','book:write',{id:{type:'string'},version:{type:'integer'},question:{type:'string'},scope:{type:'string'},exclusions:{type:'string'},reason:{type:'string'},idempotency_key:{type:'string'}}],
 ['manage_migration','Explicitly pause, resume or retry the theme migration','book:manage',{action:{type:'string',enum:['pause','resume','retry']},idempotency_key:{type:'string'}}],
 ["save_analysis_draft", "Save a theme-owned AI conversation draft with validated evidence snapshot, without AI or automatic integration.", "book:write", {"id": {"type": "string"}, "version": {"type": "integer"}, "context_token": {"type": "string"}, "body": {"type": "string"}, "idempotency_key": {"type": "string"}}],
 ["discover_relations", "Explicitly run related knowledge discovery for one current record.", "book:write", {"id": {"type": "string"}, "version": {"type": "integer"}, "idempotency_key": {"type": "string"}}],
 ["rebuild_theme", "Explicitly integrate current theme evidence and conversation hypotheses. May call AI.", "book:write", {"id": {"type": "string"}, "version": {"type": "integer"}, "idempotency_key": {"type": "string"}}],
 ["restore_view", "Restore a previous user-view version as a new revision.", "book:write", {"id": {"type": "string"}, "version": {"type": "integer"}, "restore_version": {"type": "integer"}, "idempotency_key": {"type": "string"}}],
 ["correct_membership", "Hide or restore an incorrect theme membership.", "book:write", {"id": {"type": "string"}, "item_key": {"type": "string"}, "action": {"type": "string", "enum": ["hidden", "restore"]}, "idempotency_key": {"type": "string"}}],
 ["adopt_theme_view", "Explicitly adopt or hide a current theme view proposal.", "book:write", {"id": {"type": "string"}, "proposal_id": {"type": "string"}, "action": {"type": "string", "enum": ["adopt", "hide"]}, "idempotency_key": {"type": "string"}}],
 ["merge_theme", "Merge a theme into the specified target; keeps old ID redirection and history.", "book:manage", {"id": {"type": "string"}, "version": {"type": "integer"}, "target_id": {"type": "string"}, "reason": {"type": "string"}, "idempotency_key": {"type": "string"}}],
 ["propose_concept_change", "Explicitly request an AI concept merge or split proposal without applying it.", "book:write", {"action": {"type": "string", "enum": ["merge", "split"]}, "node_ids": {"type": "array", "items": {"type": "string"}}, "reason": {"type": "string"}, "idempotency_key": {"type": "string"}}],
 ["get_concept_change", "Read a saved concept change and its impact.", "book:read", {"id": {"type": "string"}}],
 ["apply_concept_change", "Apply the reviewed concept proposal with current mapping checks.", "book:manage", {"id": {"type": "string"}, "idempotency_key": {"type": "string"}}],
 ["undo_concept_change", "Undo a concept change if mappings have not changed.", "book:manage", {"id": {"type": "string"}, "idempotency_key": {"type": "string"}}],
 ["get_import", "Read a document import and selectable sections.", "book:read", {"id": {"type": "string"}}],
 ["select_import_items", "Select 1–20 sections from an existing document import.", "book:write", {"id": {"type": "string"}, "ordinals": {"type": "array", "items": {"type": "integer"}}, "idempotency_key": {"type": "string"}}],
 ["export_records", "Export saved entities in bounded pages without credentials. Original files use authenticated Web export.", "book:read", {"entity": {"type": "string"}, "cursor": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 50}}],
 ['save_file','Save an explicitly supplied image or audio file as a record.','book:write',{file:{type:'object'},note:{type:'string'},idempotency_key:{type:'string'}}],
 ['attach_file','Attach an explicitly supplied image or audio file to a current record.','book:write',{id:{type:'string'},version:{type:'integer'},file:{type:'object'},note:{type:'string'},idempotency_key:{type:'string'}}],
 ['start_import','Import an explicitly supplied PDF, EPUB, highlights or photo using the existing parser.','book:write',{file:{type:'object'},idempotency_key:{type:'string'}}],
 ['get_operation','Read the receipt for a previously submitted MCP operation.','book:read',{operation:{type:'string'},idempotency_key:{type:'string'}}],
] as const;
export const required:Record<string,string[]>={get_record:['id'],save_capture:['text','idempotency_key'],revise_capture:['id','version','idempotency_key'],adopt_view:['id','version','idempotency_key'],get_view:['id'],revise_view:['id','version','body','reason','idempotency_key'],get_relations:['id'],get_job:['id','kind'],retry_job:['id','kind','idempotency_key'],start_research:['question','idempotency_key'],cancel_job:['id','idempotency_key'],preview_delete:['id','version'],delete_capture:['id','version','confirmation','idempotency_key'],get_theme:['id'],get_theme_context:['id'],get_history:['id'],revise_theme:['id','version','idempotency_key'],manage_migration:['action','idempotency_key']};

required["save_analysis_draft"]=["id", "version", "context_token", "body", "idempotency_key"];
required["discover_relations"]=["id", "version", "idempotency_key"];
required["rebuild_theme"]=["id", "version", "idempotency_key"];
required["restore_view"]=["id", "version", "restore_version", "idempotency_key"];
required["correct_membership"]=["id", "item_key", "action", "idempotency_key"];
required["adopt_theme_view"]=["id", "proposal_id", "action", "idempotency_key"];
required["merge_theme"]=["id", "version", "target_id", "reason", "idempotency_key"];
required["propose_concept_change"]=["action", "node_ids", "reason", "idempotency_key"];
required["get_concept_change"]=["id"];
required["apply_concept_change"]=["id", "idempotency_key"];
required["undo_concept_change"]=["id", "idempotency_key"];
required["get_import"]=["id"];
required["select_import_items"]=["id", "ordinals", "idempotency_key"];
required["export_records"]=[];

required.save_file=['file','idempotency_key'];required.attach_file=['id','version','file','idempotency_key'];required.start_import=['file','idempotency_key'];required.get_operation=['operation','idempotency_key'];
