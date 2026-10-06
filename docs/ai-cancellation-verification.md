# Scoped AI cancellation verification

Local changes based on `main` at `8faadd839bed02d2b8258bdc715f8c2996e15cae` (2026-10-06).
PR #50 was used only as a starting reference. The current #54 activity dock,
#61 integration behavior, and #62 explicit text-save/discovery flow are retained.

## Behavior

- Each Web AI request carries a durable operation ID. A stop arriving before the
  start creates a tombstone, so a delayed/replayed request cannot restart AI.
- D1 result transactions check an operation fence atomically. Final single-item
  results and successful final batch items also mark completion in that transaction.
  A stop that loses to completion reports completed, not canceled.
- Provider fetches receive an AbortSignal; cancellation is polled while an AI call
  is in progress. Late output is rejected even if a provider ignores the signal.
- Queued roots have one canonical owner. Duplicate tabs observe that owner rather
  than replacing it. Newly created child jobs inherit ownership inside their result
  transaction, before a concurrent dispatcher can publish them. Original-input transactions
  also assign their root owner atomically, while allowing the original to save
  when an early stop already exists.
- Text extraction and subsequent discovery share one operation. Stopping at the
  boundary keeps the original and completed extraction, and prevents discovery.
- Cancellation-safe terminal cleanup releases failed/canceled integration records
  and proposal attempts for explicit retries. Durable attempt ownership also lets
  the cancellation endpoint clean up immediately if the original request vanishes.
  Already committed results are kept.
- The existing detail-page stop buttons resolve the same operation. Explicit
  connector retries get a new owner when retrying a stopped Web job, preventing
  an old stop or delayed registration from canceling that new attempt. Owner
  renewal and the retryable job state are committed in one transaction, including
  import selection/retry after a completed parse.
- The existing dock distinguishes stopping, confirmed cancellation, completion,
  failure, and an unconfirmed stop with a retry action. Reload restores status
  through GET requests only. Explicit AI is not replayed from the offline outbox.
  Canceled imports expose an explicit extraction retry. Direct integration retries
  rotate their idempotency key only after confirmed failure/cancellation; completed
  and network-ambiguous requests retain their key.

- Queued completion checks every current, authorized child in the same final-result
  transaction. Dormant, unrequested capture/theme jobs do not hold research open;
  superseded generations report failure rather than false completion. Multi-target
  rebuilds finish only after the last active target.
- Exact graph/theme rebuild duplicates reuse their canonical operation. An
  overlapping graph batch is rejected before any partial claim or job creation.
- Global dispatch maintenance does not inherit a foreground operation's ownership.
  A later legacy automatic repair can proceed past an old completed owner; canceled
  and failed owners remain blocked until an explicit retry.

## Covered operation entrypoints

Extraction/import extraction and retry; deep dive; relation suggestions; record
and theme discovery; direct and batch integration; integration proposal generation;
record answers; concept/theme plans; graph/theme rebuild; research and retry.
Legacy automatic-ingestion descendants are also tracked (graph, theme, embedding,
bibliography, reflection, import/research child captures). Manual saves/apply/undo
remain on their existing paths.

The new Web operation protocol is not a blanket new MCP cancellation API. Existing
MCP job controls remain supported; explicit retries of stopped tracked jobs were
regression-tested.

## Passed checks

- `npm run check`: passed (TypeScript)
- `npm test`: 230 passed, 0 failed, 0 skipped
- `npm run build`: passed, Cloudflare dry run only
- JavaScript syntax checks for changed browser files and the new browser smoke script
- `git diff --check`: passed
- All 22 migration files, including `0020_ai_operations.sql`, are applied by the
  in-memory SQLite/D1-compatible test fixtures

The new regression coverage includes cancel-before-start, queued cancellation,
provider abort, delayed provider responses, both orders of save/stop races,
independent operations, duplicate tabs, extraction/discovery boundaries, proposal
and direct integration retry, terminal receipts, final batch completion, detail
stops, stale versions, connector retry, failed stop acknowledgement/retry, and
read-only reload. Additional review regressions cover import parse/selection and
retry, canceled-import controls, integration retry-key rotation, queued completion
races, dormant research children, superseded captures, duplicate rebuilds, mixed
ownership, unrelated legacy repairs, and retry-registration polling gaps. Tests use
synthetic data and provider doubles. The test helper
rejects unexpected external network requests.

## Mac runtime and browser verification (2026-10-06)

- Node 24 and a separate headless Playwright Chromium were used. No existing
  browser, profile, foreground window, or paid AI provider was used.
- The aggregate browser suite covers auth, cancellation, activity, capture,
  expansion, ideas, themes, discovery, text discovery, explicit execution,
  drilldown, connections, and integration proposals.
- Actual workerd rejected the original eight-term job-state UNION because its
  compound SELECT limit is five. Migration 0020 now resolves each owned job with
  indexed joins, retaining current-generation and superseded-job behavior.
  All 22 migrations applied successfully to disposable local D1.
- The local Worker/D1/R2/Queue check passed with synthetic PDF parsing, login,
  sync, and cleanup. A separate explicit-policy runtime check passed cancellation
  tombstones, extraction status, durable stop, original retention, retry ownership,
  and isolation from an older stop. AI keys were empty.
- Browser verification exposed a retained Blob-only outbox entry without a path;
  the action descriptor now safely ignores incomplete entries. The browser
  fixtures retain the existing two-to-three-candidate deep-dive contract and wait
  for delayed route handlers to finish before removing them. Auth checks verify
  the intended Access reauthentication page even when it replaces navigation.
- Transient operation/replay metadata is excluded from the integration proposal
  display signature. Status polling retains expanded evidence, selections, DOM
  identity, and scroll position when the saved proposal content is unchanged.

## Limits

- Stopping prevents further application saves/stages and requests provider abort.
  It cannot guarantee refund or reversal of computation already performed by an
  external provider. Cancellation polling can take about one second plus DB latency.
- Cancellation is forward-looking: committed prior results and original records
  are intentionally preserved. Provider quality, paid calls, and physical devices
  are outside these synthetic/local checks. Publication evidence is recorded
  separately in PR #63 and the release report.

## Publication requirements

The final PR head must pass the full browser suite, type checks, tests, build, and
GitHub CI. Migration 0020 must be applied before the new Worker and matching static
assets are deployed. Existing production bindings, secrets, AI settings, and the
explicit execution policy must be retained. User authorization to merge and
publish PR #63 was received before the Mac verification phase.
