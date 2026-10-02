export const toolSpecs = [
 ['get_discovery','Read saved related candidates without AI','book:read',{id:{type:'string'}}],
 ['integrate_records','Integrate only the anchor, selected saved candidates and retained valid evidence','book:write',{discovery_id:{type:'string'},selected_ids:{type:'array',items:{type:'string'}},idempotency_key:{type:'string'}}],
 ['get_status','Read implementation capabilities and processing status','book:read',{}],
 ['search_records','Search all saved records without AI. Cursor pagination covers the entire history.','book:read',{query:{type:'string'},entity:{type:'string',enum:['all','capture','claim','concept','question','view','theme']},theme_id:{type:'string'},source:{type:'string'},origin:{type:'string',enum:['source','user','ai']},state:{type:'string'},since:{type:'integer',minimum:0},until:{type:'integer',minimum:0},unorganized:{type:'boolean'},include_hidden:{type:'boolean'},cursor:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}}],
 ['get_record','Read a record, evidence, and graph','book:read',{id:{type:'string'}}],
 ['extract_import','Explicitly read and extract a saved PDF/document. Saving never starts extraction.','book:write',{id:{type:'string'},idempotency_key:{type:'string'}}],
 ['extract_record','Explicitly extract insights and questions from one saved record. Never follows save implicitly.','book:write',{id:{type:'string'},version:{type:'integer'},idempotency_key:{type:'string'}}],
 ['save_capture','Save the specified text with optional source; does not fetch URL content or call AI','book:write',{text:{type:'string'},source:{type:'string'},note:{type:'string'},idempotency_key:{type:'string'}}],
 ['revise_capture','Correct a record at its expected version','book:write',{id:{type:'string'},version:{type:'integer'},corrected_text:{type:'string'},note:{type:'string'},idempotency_key:{type:'string'}}],
 ['adopt_view','Explicitly adopt the record AI draft as the user view','book:write',{id:{type:'string'},version:{type:'integer'},idempotency_key:{type:'string'}}],
 ['get_view','Read a user view and adoption history','book:read',{id:{type:'string'}}],
 ['revise_view','Explicitly edit a user view','book:write',{id:{type:'string'},version:{type:'integer'},body:{type:'string'},reason:{type:'string'},idempotency_key:{type:'string'}}],
 ['get_relations','Read saved record graph or theme relations without AI','book:read',{id:{type:'string'},entity:{type:'string',enum:['capture','theme']}}],
 ['get_job','Read ingestion, research, theme, graph or import stage status','book:read',{id:{type:'string'},kind:{type:'string',enum:['capture','research','theme','graph','import']}}],
 ['retry_job','Explicitly retry failed ingestion, research, theme or graph work','book:write',{id:{type:'string'},version:{type:'integer'},kind:{type:'string',enum:['capture','research','theme','graph']},idempotency_key:{type:'string'}}],
 ['start_research','Explicitly start external research under configured host and AI limits','book:write',{question:{type:'string'},capture_id:{type:'string'},version:{type:'integer'},subject_period:{type:'string'},url:{type:'string'},idempotency_key:{type:'string'}}],
 ['cancel_job','Cancel research, graph or theme work; does not undo an executed external call.','book:write',{id:{type:'string'},kind:{type:'string',enum:['research','graph','theme']},version:{type:'integer'},idempotency_key:{type:'string'}}],
 ['preview_delete','Inspect deletion impact and obtain a short-lived version-bound confirmation','book:manage',{id:{type:'string'},version:{type:'integer'}}],
 ['delete_capture','Permanently delete the previewed record using its confirmation and expected version','book:manage',{id:{type:'string'},version:{type:'integer'},confirmation:{type:'string'},idempotency_key:{type:'string'}}],
 ['get_domains','Read knowledge domains when the theme module is available','book:read',{}],
 ['get_theme','Read theme understanding and evidence when the theme module is available','book:read',{id:{type:'string'}}],
 ['get_migration_status','Read theme migration capabilities','book:read',{}],
 ['get_theme_context','Read saved theme context without AI','book:read',{id:{type:'string'}}],
 ['get_history','Read paginated theme, theme-change, record or user-view revisions','book:read',{id:{type:'string'},entity:{type:'string',enum:['theme','theme_change','capture','view']},cursor:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}}],
 ['revise_theme','Explicitly correct theme scope at its expected version','book:write',{id:{type:'string'},version:{type:'integer'},question:{type:'string'},content:{type:['string','null'],maxLength:10000},scope:{type:'string'},exclusions:{type:'string'},reason:{type:'string'},idempotency_key:{type:'string'}}],
 ['manage_migration','Explicitly pause, resume or retry the theme migration','book:manage',{action:{type:'string',enum:['pause','resume','retry']},idempotency_key:{type:'string'}}],
 ["save_analysis_draft", "Save a theme-owned AI conversation draft with validated evidence snapshot, without AI or automatic integration.", "book:write", {"id": {"type": "string"}, "version": {"type": "integer"}, "context_token": {"type": "string"}, "body": {"type": "string"}, "idempotency_key": {"type": "string"}}],
 ["discover_relations", "Explicitly discover related knowledge using legacy or AI-expanded search (default).", "book:write", {"search_mode":{"type":"string","enum":["legacy","ai_expanded"]}, "id": {"type": "string"}, "version": {"type": "integer"}, "idempotency_key": {"type": "string"}}],
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
 ['propose_theme_change','Preview a user-requested theme edit, aliases, merge, split, candidate or archive without applying or calling AI.','book:write',{id:{type:'string'},version:{type:'integer'},action:{type:'string',enum:['edit','aliases','merge','split','candidate','archive']},target_id:{type:'string'},target_version:{type:'integer'},question:{type:'string'},content:{type:['string','null'],maxLength:10000},scope:{type:'string'},exclusions:{type:'string'},aliases:{type:'array',items:{type:'string'}},domain_ids:{type:'array',items:{type:'string'}},capture_ids:{type:'array',items:{type:'string'}},reason:{type:'string'},idempotency_key:{type:'string'}}],
 ['get_theme_change','Read a theme change preview and its impact.','book:read',{id:{type:'string'}}],
 ['apply_theme_change','Apply a reviewed theme change only if its complete before snapshot is current.','book:manage',{id:{type:'string'},idempotency_key:{type:'string'}}],
 ['undo_theme_change','Undo a theme change if affected memberships and metadata remain unchanged; creates new versions.','book:manage',{id:{type:'string'},idempotency_key:{type:'string'}}],
 ['set_visibility','Hide or restore a record or theme without deleting its evidence or history.','book:write',{id:{type:'string'},version:{type:'integer'},entity:{type:'string',enum:['capture','theme']},action:{type:'string',enum:['hidden','restore']},idempotency_key:{type:'string'}}],
 ['save_view_proposal','Save a grounded conversation proposal without adopting it as the user view.','book:write',{id:{type:'string'},version:{type:'integer'},context_token:{type:'string'},body:{type:'string'},reason:{type:'string'},claim_ids:{type:'array',items:{type:'string'}},view_id:{type:'string'},view_version:{type:'integer'},from_text:{type:'string'},idempotency_key:{type:'string'}}],
 ['get_overview','Read domains, current questions and at most three recent substantive changes.','book:read',{limit:{type:'integer',minimum:0,maximum:3},since:{type:'integer',minimum:0}}],
 ['get_evidence','Read a versioned claim and original evidence; distinguishes current, changed and unavailable sources.','book:read',{id:{type:'string'}}],
] as const;
export const required:Record<string,string[]>={extract_import:['id','idempotency_key'],extract_record:['id','version','idempotency_key'],get_record:['id'],save_capture:['text','idempotency_key'],revise_capture:['id','version','idempotency_key'],adopt_view:['id','version','idempotency_key'],get_view:['id'],revise_view:['id','version','body','reason','idempotency_key'],get_relations:['id'],get_job:['id','kind'],retry_job:['id','kind','idempotency_key'],start_research:['question','idempotency_key'],cancel_job:['id','idempotency_key'],preview_delete:['id','version'],delete_capture:['id','version','confirmation','idempotency_key'],get_theme:['id'],get_theme_context:['id'],get_history:['id'],revise_theme:['id','version','idempotency_key'],manage_migration:['action','idempotency_key']};

required["save_analysis_draft"]=["id", "version", "context_token", "body", "idempotency_key"];
required["get_discovery"]=["id"];
required["integrate_records"]=["discovery_id","selected_ids","idempotency_key"];
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

required.propose_theme_change=['id','version','action','reason','idempotency_key'];required.get_theme_change=['id'];required.apply_theme_change=['id','idempotency_key'];required.undo_theme_change=['id','idempotency_key'];

required.set_visibility=['id','version','entity','action','idempotency_key'];

required.save_view_proposal=['id','version','context_token','body','reason','claim_ids','idempotency_key'];

required.get_evidence=['id'];
