# Theme knowledge: Issues #14–#19

The six Domains are entrances, Theme is a continuing question, Lens is an optional comparison,
Capture/Harvest retain original claims, and ThemeSynthesis is AI interpretation. A single Question
is an unresolved item, Concept joins terminology, and only an explicitly adopted View is the user's position.

Migration 0009 creates six empty seeded questions and five lenses. It queues existing current Harvests
without re-reading images/audio. Domain and seed INSERTs use stable IDs and INSERT OR IGNORE; they do
not overwrite user corrections. Schema migrations are applied once through d1_migrations.

New Harvests enqueue membership in the same D1 batch. Membership triggers enqueue a debounced theme
refresh atomically. Theme jobs have leases, bounded retries, version guards and a durable outbox.
The current result changes only after all input Capture/Harvest/Theme/View versions are checked.
Raw captures remain available when AI is unavailable. Daily limits and ChatGPT authentication are reused.
No separate embeddings service is required. Every new capture adds one membership call; each affected
active theme adds a synthesis call after a 15-second debounce, within the existing daily 60-call limit.

Selection searches the all-years theme index, retaining prior evidence and prioritizing counterexamples
and conditions, then recent material and up to three related themes. Limits: 12 materials, 72 claims,
6 relevant Views, 150,000 input characters, 10 dispatched jobs, 20 backfill rows per pass.
Material fingerprints identify copies; AI-derived claims are explicitly excluded from the reported
independent-material count. A Lens can retrieve another Domain, but the model must provide both sides'
original claims and explain important differences before a theme relation is accepted.

Candidate questions are hidden from normal home. Existing active/candidate questions are sent first;
new candidates have deterministic question/scope IDs. Activation requires three distinct material
fingerprints. There are at most 20 candidates and 24 active themes. Similar wording is reused by the
membership model, rather than a forced lexical merge. Human edits/merges are versioned API operations.
Actual semantic deduplication quality remains an empirical evaluation task.

Each explanation has verified Claim IDs and exact Harvest quotations. Theme-owned old-A/old-B edges
are independently versioned, and appear in local graph exploration only while their dependencies are
current. No synthetic Capture is created. Deleted/corrected/hidden evidence becomes invalid immediately;
old explanations are marked stale until regeneration. View text/history is never automatically revised.
Explicit proposal adoption stores the synthesis revision and original evidence snapshot.
No-change generations keep prior wording and are omitted from semantic change history.

## APIs (existing session/Cloudflare Access and same-Origin rules)

- GET /api/themes, GET /api/themes/:id, GET /api/themes/:id/history
- GET /api/captures/:id includes related themes
- POST /api/themes/:id/proposals: {proposal_id, action: adopt|hide}
- PATCH /api/themes/:id: {version, question?, scope?, exclusions?, reason?}
- POST /api/themes/:id/overrides: {item_key: theme|capture:ID, action: hidden|restore}
- POST /api/themes/:id/merge: {version, target_id, reason}; old ID redirects, history is retained
- GET /api/themes/migration reports job state, remaining current Harvests, pause state and limits
- POST /api/themes/migration: {action: pause|resume|retry}; retry handles at most 20 failed/blocked jobs

Backfill pauses affect historical membership jobs, while newly saved records continue. A resume
continues only outstanding records. Exports include themes, memberships, explanations, quotations,
relations, dependencies, ID mappings, overrides and adoption history. Existing D1/R2 backup guidance applies.

## Verification boundaries

Unit/integration provider doubles validate association, unassigned records, multiple themes referencing
one capture, 1,010-history retrieval, old Views, quote rejection, past-only edges, version races,
source edits/deletion, explicit adoption, cross-domain Lens retrieval, migration controls and merges.
These fixtures are synthetic; passing them does not certify real-model semantic judgment.
`theme-browser-smoke.mjs` checks 390/1280px, one primary home action, explanations, quotations and
return paths. The local environment cannot download Chromium; GitHub CI runs the browser suite.
Real ChatGPT quality, mobile device behavior and backup restoration are tracked separately.
