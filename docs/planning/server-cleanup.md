# Server cleanup review

This document tracks the open findings from a review of every source, test, configuration, script, and documentation file under `apps/server`, including hidden files; generated output and dependencies are excluded. An entry is removed once its cleanup is done or its file is gone.

Each remaining entry records the behavior the file serves, a keep/refactor/simplify/cut assessment, concrete evidence, and the behavior a cleanup must preserve. Test entries distinguish useful regression protection from assertions or scaffolding that can be removed.

## Where the cleanup pays off

Most useful savings come from narrowing two large boundaries, the chat workers and the workflow item engine, and removing repeated reads/assembly around them. Most small files already have a clear job; collapsing services, authorization or durable recovery into fewer files would often remove guarantees rather than complexity.

These findings come from reading source, tracing callers and inspecting test assertions. The server test suite and live flows were not run for this documentation-only review. Code-path issues below need focused regression tests before implementation; product-policy questions are explicitly conditional in the file notes.

### Behavior gaps to resolve before structural refactoring

| Area                  | Trigger and consequence                                                                                                   | Source evidence                              | Suggested direction                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Avatar download bound | A permitted image response omits or lies about Content-Length. The entire body is buffered before actual size is checked. | `fetchClerkImage` in `org/Users.handlers.ts` | Enforce a streaming byte limit and timeout; preserve the remote-host policy through redirects. |

Other concrete review targets include missing shell pagination and HTTP missing-asset fallback. They are detailed under their owning files; avoid combining them into one refactor.

### Small cuts and decisions

- Remove identity-only fixture aliases (`addHelperAgent`), redundant service-construction prose and the stale comment about later steps declaring carried inputs. These do not require business-model changes.
- Consolidate duplicated actor/projection and field-value validation helpers without adding a configurable framework.
- Keep blocked-work completion and due-date policy out of mechanical cleanup. Each changes product behavior and needs an explicit decision.

### Tests to remove or merge

These are concrete deletion candidates, with the useful behavior retained elsewhere. File notes contain the full assessment.

| File                                    | Remove or merge                                                                                               | Coverage to retain                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| workflows/WorkflowItemService.test.ts   | Remove absent-key “An item has no assignee”.                                                                  | Actual assignment, not DTO key absence.                                      |
| workflows/WorkflowNotifications.test.ts | Merge the two notification/My work opening cases, which both call stepView identically.                       | Valid target, returned step and unread transition.                           |
| workflows/WorkflowLifecycle.test.ts     | Merge the second send-back comment case and repeated blocked/rejected row fixtures into transition scenarios. | Reason/author, retained values, permission failures and reverse transitions. |
| workflows/WorkflowAgents.test.ts        | Merge the second give-up-with-note scenario into the fails/gives-up table.                                    | Human fallback, note and failed outcome.                                     |

Keep durable chat recovery/input replay, publication rollback/stale-preview rechecks, private-content access, session revocation/admission races and the runner outage versus refusal distinction. They cover failures that mocks or a few happy-path tests cannot replace. Shrink their repeated setup before deleting scenarios.

### Suggested order

Make the small unused-code/comment/test cuts independently. Then extract one private worker/engine boundary at a time, preserving transaction and resource ownership. Finally batch query/context assembly and measure the improvement; do not add caches that can retain stale permissions. Leave optional feature/policy changes for separate decisions.

## Findings by file

### `src/attachments/http.test.ts` — Keep privacy/download safety; merge helper-only overlap

Route tests prove upload/read bytes, privacy from other members and administrators holding the URL, reads through a chat that holds the file, anonymous/pending denial, missing files and upload limits. Keep these. The header-helper tests for defaults/plain document/name overlap returned-route assertions; merge those duplicates into route cases rather than separately asserting every constructed object. Keep dangerous MIME/XML versus legitimate Office types and Unicode/control/surrogate filename cases: those are subtle externally observable download safety, not formatting trivia. Convert MIME examples to tables for useful per-case failures.

### `src/attachments/http.ts` — Keep safe serving

Validates upload metadata, streams request bytes, returns IDs and serves the files the viewer may read with inert download headers. Keep Unicode-safe RFC 6266 filenames, nosniff, private caching and sandboxed dangerous downloads; these are observable security behavior. The read route matches `/*` and slices the attachment ID out of the path itself; declare it as a route parameter if the router permits it, rather than a second path-parsing convention. Do not remove filename/MIME safety tests as mere formatting tests.

### `src/auth/ClerkIdentityProvider.test.ts` — Keep security cases; share expensive signing fixtures

Verifies real signed tokens/local JWKs across issuer, expiry, subject, verified email, authorized party and invalid signature, and distinguishes JWKS failure from rejected credentials. These cases validate our integration policy, not merely jose internals. Keep all negative policy dimensions. Keep the second key for invalid-signature coverage. The issuer-derivation scalar case overlaps valid-environment construction and can merge into it. Use fixed JWT time/currentDate control so expiry assertions do not depend on wall-clock boundaries. Add image-host and decoded-key URL-feature validation when correcting those boundaries, without mocking cryptographic verification away.

### `src/auth/ClerkIdentityProvider.ts` — Keep verification; simplify validation/error plumbing

Verifies signed Clerk identity, issuer, algorithm, expiry, verified email and optional authorized party; derives the tenant/JWKS endpoint and restricts suggested image URLs. These checks are real admission policy. Replace manual claim-shape checks with one Schema decode after cryptographic verification, while retaining distinct invalid-token versus unavailable-provider outcomes. The nested throw/tag-detect/catch path in `verify` can be flattened into a verification adapter and claim decoder. `IdentityTokenValidationFailure` only exists to carry a diagnostic string; a typed validation error can carry that reason directly. Do not drop `azp` validation or start rejecting absent `azp` without changing the intended sign-in contract. Tighten the publishable-key “bare host” parser: its current slash/URL checks also allow URL features such as userinfo, port, query or fragment in decoded data, contrary to the comment. Configuration is operator-supplied, but failing clearly is still useful. Keep the narrow HTTPS image-host allowlist; redirect handling must also be considered where the image is fetched.

### `src/auth/http.test.ts` — Keep wire behavior; consolidate handler/layer setup

Tests the cookie exchange, Clerk login refusals with the `AuthFailure` body and no cookie, the session state a signed-in browser reads, and logout keeping other sessions. Those HTTP behaviors are valuable and not duplicated by service tests. The `identities` and `verified` fixtures are module-global and shared by every case; build the Clerk fake per test so isolate:false and failed cases cannot leak state. Add no-store, SameSite and production Secure checks when cookie policy changes.

### `src/auth/http.ts` — Simplify cookie/error helpers; move self-service rules into a service

Owns the Clerk login exchange, session introspection, logout, and the `member` check the raw routes share. Keep no-store on credential-bearing responses, HttpOnly cookies and a separate logout path. Cookies have SameSite=Lax but no Secure flag; decide it from the trusted deployment scheme/config while preserving HTTP localhost development. The session route sends no `no-store` although it discloses the user's identity and role; consider adding it.

### `src/auth/SessionStore.test.ts` — Keep storage/security behaviors; improve cookie stability check

Current role/state refresh, token expiry/unknown rejection, owner-scoped revocation, revocation feed and cookie namespacing are meaningful and distinct. Keep the TestClock expiry and observable revocation stream. The cookie test only proves two different temp dirs produce different names and matches the hash format; use the same explicit directory twice to prove restart stability too, and drop the exact 12-character/hash-format assertion unless it is externally contractual. Add an independent assertion that raw tokens never appear in stored rows if changing issue/hash code. No whole behavioral scenario is an obvious deletion candidate.

### `src/auth/SessionStore.ts` — Keep core and construction seam; simplify retention

Issues random opaque cookies, stores only hashes, checks current user role/state and publishes revocations. Keep hash-only storage and cookie names scoped by state directory, since browser cookies ignore ports. The exported `make` has a real consumer in Members.test.ts, which decorates the actual implementation for rollback/ordering scenarios; keep that construction seam. Replace the generic `@public` rationale with its concrete use if a comment is needed. Expired rows are refused but never deleted in this file; add bounded cleanup at issuance/startup if there is no other owner. Deletion and revocation publication are separate effects: callers can publish inside a transaction before commit, or interrupt after deletion, leaving held streams inconsistent. Prefer post-commit notification and a short interruption-safe boundary, not a second durable event subsystem. Held streams also need expiry handling; this store only checks expiry when authenticating. Avoid changing 30-day TTL as part of a mechanical cleanup.

### `src/auth/UserAuth.ts` — Simplify service shape; keep transactional admission

Turns verified identity into an approved/pending/deactivated membership decision and an ordinary server session. Preserve token verification outside the SQL transaction, first-user administration, admission/session atomicity, confirmed-name preservation and current email/avatar suggestions. Normalize the old interface-plus-Context.Service definition to the class with inline interface used elsewhere. `toInternalError` only constructs an error; inline it or make a meaningful error factory, and use Schema.TaggedError rather than the isolated Data.TaggedError form. Avoid conditional object spreads for optional properties when the types can accept undefined directly. These are modest readability cuts, not reasons to split a small service into admission/profile/session coordinators.

### `src/bin.ts` — Keep

The 14-line composition root resolves configuration, scopes resources, provides Node services, and runs the server. It has no CLI compatibility layer or hidden work. No useful cut. Consider duplicate `NodeServices.layer` provision together with `server.ts`, rather than changing either independently.

### `src/chats/AttachmentPrompt.test.ts` — Keep both; reduce prose snapshot brittleness

One test checks usable image/document paths; the other checks quote escaping, preserving answer selections and special-key safety without mutation. These are distinct meaningful behaviors. Assert references/path/retained answers without pinning every surrounding sentence if prompt wording is not a contract. Add the length-bound/omitted-reference behavior when that policy is decided. Do not remove the prototype-key case as an arbitrary edge: object construction otherwise changes answer meaning.

### `src/chats/AttachmentPrompt.ts` — Simplify naming/quoting; keep form semantics

Adds VM-local attachment references to prompts and form answers. Rename `providerMessageTextWithAttachmentPaths` to a chat/OpenCode-specific name; only one provider remains. Message references interpolate raw names inside quotes, while answer references JSON-quote both name/path; use the same escaping to prevent newline/quote ambiguity. Keep answer-array preservation and the message length bound. Silently dropping references when the prompt is full can leave uploaded files undiscoverable; reserve a bounded attachment section or explicitly report omitted references rather than silently accepting a misleading prompt. Do not add a second attachment metadata model.

### `src/chats/ChatEvents.ts` — Keep backpressure behavior; retain service-level overflow coverage

Implements filtered per-subscriber bounded queues, replacing an overflowed backlog with a resnapshot marker. This protects memory for slow tabs and avoids forcing every subscriber to retain all chats' deltas. A plain unbounded PubSub is not equivalent. The synchronous set/unsafe queue operations are localized and avoid yielding halfway through clearing the backlog; preserve that atomicity if replacing them with standard APIs. Consider coalescing duplicate row invalidations before the 1,000-event cap, but keep ordered text deltas until a resnapshot. ChatService.test.ts already covers overflow causing a fresh snapshot; keep that observable test instead of duplicating private queue implementation checks. Cover filtered isolation and scoped subscriber cleanup when changing those paths. No benefit in exporting Subscriber or the queue implementation.

### `src/chats/ChatRepository.ts` — Refactor workspace storage boundary; retain durable capture semantics

Owns chat rows, ordered/idempotent inputs, native session/message capture, questions, tombstones and workspace archives. The wide interface is substantial but mostly corresponds to real durable state; do not split one chat transaction across independent repositories merely to reduce file length. Keep the workspace's save via `.part`. A typed storage error should replace blanket `orDie`, allowing the worker to distinguish persistence failure from a sandbox outage rather than retrying/misclassifying both. `MessageRow` is still an interface over an unchecked SQL annotation; decode it as sessions and questions are.

The useful simplifications are local: use specific conflict targets for chat/input idempotence, batch question deletions/inserts, and compare/update changed form JSON rather than only its ID. `putSession` updates info JSON but not parent ID on conflict; assert parentage is immutable or update it consistently. The restore threshold of 4,000 messages does not bound a huge uncompacted chat: without a completed compaction `settled` still loads every message, so enforce actual import byte/message limits at the restoration boundary. The chat list query is already owner-filtered SQL, not a shared list projection, but returns every matching chat without a limit; add cursor pagination when the UI can consume it. `captureIn` advances ordinals, messages, cursor and materialized inputs together; preserve that atomicity and retry idempotence. `loseVm` persists the loss note with the lost messages in one transaction; keep it.

The comments claiming cancellation cannot return should be checked against capture materializing any matching input state, including cancelled, when native delivery has already won the race.

### `src/chats/ChatRestore.ts` — Keep recovery explanation; tighten bounded diagnostics

Constructs a synthetic note explaining interrupted work, completed tools, lost questions and restored versus empty workspace. This is useful user/agent behavior and should not be cut as a comment-like feature. Keep notes passive: restoration must not silently rerun an interrupted external action. Bound the total note size, not just each tool input, because many lost messages/questions can still produce a huge import. Quoting a JSON tool input before truncation can allocate a large string; use bounded/sanitized rendering where practical. A lost-message list containing only non-assistant/shell/compaction entries produces a generic note with no per-message explanation; ensure the caller's selection makes that meaningful. Add direct behavior coverage for restore notes if the worker tests do not assert their visible content.

### `src/chats/Chats.testkit.ts` — Refactor fixtures to per-test instances

Provides a real isolated database/ChatService plus mutable fake runner/OpenCode and feed-based waits. Keep observable queue signals and scoped temp state. Exported module-global fakes plus resetFakes rely on tests never overlapping and become fragile with isolate:false; expose a fixture constructor returning layer/runner/openCode per test. The direct SQL user/agent seed helpers are appropriately minimal for chat-domain tests; no need to exercise sign-in in every chat test. Keep silence timeout override confined to fake-server tests, with a separate real timeout test. The unbounded test event queue is convenient but should be closed by scope, and next should preserve useful stream failures rather than converting everything to an opaque defect.

### `src/chats/ChatService.test.ts` — Keep durable behavior; add live-feed coverage before changing it

Covers a member's chat started by its first message once and never after its delete, agent gates for members and steps, inputs saved once per id with conflicts, titles, deletion cleanup across a runner outage, file-binding refusals, posts inside a caller's transaction and their after-commit announcement, capture delivering inputs, a slow stream's fresh snapshot, and paged reads. The slow-stream case already covers ChatEvents' overflow, so do not add a duplicate implementation-level queue test. Add filtered-stream isolation, subscriber disposal and subscribe-during-change coverage before changing live feeds. SQL inspection is justified for durable ledger/cancellation guarantees, not for every display field.

### `src/chats/ChatService.ts` — Refactor read assembly and authorization boundary; retain one command service

Coordinates every chat capability for users and automation: durable send, cancellation, questions, stop/compact, rename/delete, list/read streams and startup cleanup. Keep reads entirely local and input persistence before worker wake. Splitting read/snapshot assembly into a private module could shrink the service while keeping commands and lifecycle in one owning service. Do not create a separate service per command.

Reads cut every long string and every property literally named `data`, potentially altering IDs, URLs or structured tool fields, then decode the result against the original schema; narrow the cut to known display-heavy fields so legitimate large messages cannot defect during reads, and bound traversal if a sandbox can create pathological JSON. Keep full stored bytes for restore and the whole-message fetch. An answered form can consume/bind files before native answer validation fails, so failed answers need a defined retry/release policy. Keep input-ID content fingerprints; JSON serialization order for context objects should be canonical if semantically identical retries are meant to match.

The list subscription is already a normal owner-filtered query refreshed from invalidations, not the removed shared projection. Keep subscribe-before-initial-read ordering and bounded/grouped invalidations. The message-page byte target is explicitly “at least one,” not a hard payload cap; huge single messages can exceed it even after truncation. Single-message fetch is wholly unbounded by this layer, so state the intended request-size contract. Cleanup retry catches causes but retries only typed failures; repository defects can escape the retry promise, and interruption should not start another background cleanup. Preserve immediate tombstones and recoverable cleanup on restart. Rename failures are intentionally ignored after durable local success; keep that distinction from a failed rename itself.

### `src/runner/RunnerService.integration.test.ts` — Keep scenario coverage; add targeted gaps

Covers the worker end to end over the real database and the fake runner and OpenCode, grouped into general worker behavior, a VM the runner refused and a lost VM. Several expected IDs/import lists use the production ID helpers, so retain independent checks of uniqueness/privacy rather than treating matching helper output as proof of ID construction. Use TestClock only to exercise actual time policy, not as a substitute for a work-completed signal. Add more-than-one-page shell behavior and native-event backlog cases as targeted gaps during worker refactoring.

### `src/runner/RunnerService.ts` — Highest-value refactor; retain single-owner worker model

The worker is the main OpenCode boundary: VM boot/restore, native event reconciliation, input delivery, queued VM commands, workspace saves, idle expiry, reconnect and worker registry races. Those responsibilities are real; the simplification is to separate testable phases, not remove durable behavior. Extract a native capture/reconciliation module (session tree, messages/forms/activity and event marks), a boot/restore procedure and a workspace-save policy. Leave one worker loop as the sole VM owner and one registry controlling worker creation/removal. Explicit phase results such as asleep/retry/failed are clearer than distributed booleans, but do not add a generic actor framework.

Concrete fixes to consider before cosmetic extraction:

- The mailbox is unbounded and receives an `events` item for every marked native event even though Marks already coalesces their effects. Use a single pending-capture notification with an urgent flag while retaining separately queued member jobs/wakes. Slow capture or VM jobs otherwise allow an arbitrarily large redundant backlog.
- A malformed model becomes undefined and create/import omit it, letting OpenCode select a default. Fail explicitly at the boundary; the shared parser's own comment says silent defaulting records the wrong model.
- Both activity detection and a stop's shell removal read only the first shell page. Paginate consistently; otherwise a running shell can be missed and its VM slept/stopped incorrectly.
- `captureSession` re-fetches the whole stored session list for every session, while tree reconciliation repeatedly scans held sessions. Index session state once per pass, retain incremental captures and keep paged tail cursors. Batch repeated row reads where possible.
- A permanently refused root import creates a fresh root and continues while history remains only in T45. Surface a durable visible recovery failure/note instead of silently presenting a continued conversation whose model lacks its history; this is a behavior decision to preserve or deliberately change.
- Missing/refused attachment transfer is logged and skipped while the prompt still says the file exists. Define whether that input must be refused, or visibly explain the missing file, instead of claiming successful delivery.
- Distinguish storage defects from runner/OpenCode failures before retry classification. An unavailable persistence layer must not be diagnosed as “the chat's VM failed.” Cap backoff explicitly as now, and preserve interruption.

Keep subscribe-before-read, loss-note atomicity, deterministic native input IDs, capture-before-redelivery after reconnect, pre-delivery rechecks under the delivery lock, scoped event-stream disposal, workspace refusal limits, and registry compare-by-mailbox removal. The 5-minute idle and 30-minute unanswered-question limits are business/resource policy, not obvious dead code. Workspace loss notes correctly stay passive. Refactor these sections against the existing worker scenarios rather than mirroring each new private function with a unit test.

### `src/config.ts` — Simplify small scaffolding; retain configuration ownership

Owns runtime settings, derived userdata paths, directory creation, and isolated test configuration. Keep explicit state-root derivation and scoped temporary test directories. The verbose module/type comments add no information and can go. Test-only construction could live in a testkit if it reduces production-facing exports, but that move alone saves little. No database-path compatibility shim is needed for a clean-slate rename, but renaming `statev2.sqlite` by itself brings little benefit.

### `src/opencode/OpenCode2Client.test.ts` — Keep bounded I/O and protocol checks; replace yield loops

Tests silent-stream failure, strict event decoding, exact file bytes/path encoding, declared and streamed size caps, and stopping oversized SDK responses before reading the rest. Keep both advertised-size and chunked-size cases: they exercise different attack/failure paths. The first test loops yieldNow 20 times to “let the timer start”; replace with an observable first-frame/stream-consumption signal before TestClock advances. The cap tests allocate around 64 MB per run; inject a small test cap or test the bounded primitive directly while retaining one realistic configuration assertion, instead of repeatedly allocating production-size bodies. Preserve cancellation/backpressure observations. No value in tests that only assert helper export existence.

### `src/opencode/OpenCode2Client.ts` — Keep integration boundary; simplify duplicated bounded reads

Adapts the upstream client, authenticated SSE subscription, cursor pagination, session trees and bounded raw file reads. This is exactly where OpenCode-specific complexity belongs. Keep subscribe-before-work semantics, timeout on raw SSE bytes so heartbeats count, strict event decoding and cursor/order handling. `bodyUpTo` and `capResponses` implement related byte limits with different outcomes; share a small bounded byte stream primitive if it genuinely removes duplicate accounting, without erasing “optional oversized file” versus “invalid oversized API response.” The body cap excludes SSE, whose individual frames can still be arbitrarily large; decide an event-frame bound at the decoder boundary. Check cancellation/disposal when reconstructing Web Responses around Effect streams (`capResponses`), especially interruption before full consumption. `modelRef` must be checked by callers; allowing undefined would run an unintended default model. `sessionsUnder` has a useful iterative cycle guard; do not replace with unbounded recursion. Rename `OpenCode2` only if version distinction is no longer used anywhere, in one complete boundary move.

### `src/org/Members.test.ts` — Keep transactional/security scenarios; assert outcomes, not calls

Covers approval/decline, admin-only management, last-admin protection, role/deactivation revocation, hook and revocation rollback, concurrent self-demotions, sign-in/deactivation ordering and a role change landing during a profile update. These are substantial business invariants; do not cut the race/rollback cases because they need more setup. The explicit Deferred around issuance is useful; replace the `yieldAfterReads` scheduling assumption with barriers at the meaningful authorization/write boundary where possible. Exact arrays recording `revokeAllForUser` calls can be replaced by authenticated-token invalidation; the decline and sign-in-race cases already show that stronger pattern. The suite uses a fake workflow-deactivation participant, so the separate real participant tests are still needed. `SessionStore.make` is genuinely imported here to decorate the real implementation for failure/ordering tests; keep this purposeful construction seam.

### `src/org/Members.ts` — Keep the transactional lifecycle; count admins in a query, revoke after commit

Approval, decline, role and state changes read the acting admin and the target and write in one transaction, the workflows' deactivation hook included; keep that. Last-admin protection loads every user to count the active admins; a named `UserRepository` read would do. Session revocation is published inside the transaction, before its commit, so a failed commit can end streams for a change that did not land; decide and test post-commit publication while preserving immediate enforcement. `users.list` in `Users.handlers.ts` returns pending and deactivated members to every active member; expose an active directory separately if ordinary People access should not include the approval queue.

### `src/org/UserRepository.test.ts` — Keep persistence behavior; order the list by time

First-versus-later admission and concurrent first-login selection are valuable database guarantees. The first case lists two users registered at the same time with IDs in sorted order, so it tests only the tie-break; use distinct reversed timestamps.

### `src/org/UserRepository.ts` — Decode the avatar row

Decodes the shared `models/User.ts` model, atomically chooses the first administrator and keeps avatar bytes out of ordinary user queries. Keep that narrow ownership. `avatarImage` has only a TypeScript row annotation, unlike the decoded user rows; decode it at that boundary too.

### `src/persistence/Schema.ts` — Keep central schema; prune only alongside removed features

Defines all persisted behavior and refuses databases with a different DDL fingerprint. Keep in-place schema edits before release; do not introduce migrations or backward compatibility now. Some IDs are loose text (polymorphic assignees). Make these omissions deliberate: deletion/tombstone handling may require loose references, but ordinary referential integrity should not depend on every caller remembering cleanup. Boolean/state checks are uneven; add constraints only for real invariants. The schema fingerprint changes even for DDL whitespace, which is acceptable under the current clean-slate policy but should be understood before formatting SQL. Fix indentation. A schema split by domain would hide the one authoritative initialization order and is not an automatic improvement.

### `src/persistence/Sqlite.test.ts` — Keep behavior tests; remove real-time lock scaffolding

Busy-write tolerance, WAL truncation, template parity and per-test isolation/pragmas all protect meaningful runtime/test guarantees. The lock-holder child uses a 300 ms timer: replace it with an IPC/stdin release handshake, and always terminate/await the captured child in a finalizer. Waiting for stdout is already the right acquisition signal; silently discarding stderr makes failures hard to diagnose. The WAL test really writes tens of megabytes; keep it as an integration check, and consider whether it needs every routine unit invocation. Template parity and independence should move with the test-image implementation if production/test files are separated. Do not remove the isolation tests while retaining the custom image optimization.

### `src/persistence/Sqlite.ts` — Move test construction out; keep database policy

Enables foreign keys, limits retained WAL size, initializes/checks schema and constructs production or isolated test connections. Keep the two pragmas and startup schema refusal. Half the module is test-image caching and temporary-database creation, including a module-level `Effect.runSync`; move that to a persistence testkit so importing production persistence does not construct a runtime-backed cached effect. The cached schema image is a meaningful suite-speed optimization; retain it if measured, rather than rebuilding a thousand schemas. Keep copied databases independent and reapply connection-local pragmas. `layerFromPath`'s function returning a Layer through `Effect.fn(..., Layer.unwrap)` is compact but unconventional; a straightforward Layer.unwrap constructor could improve readability without a new abstraction.

### `src/runner/FakeOpenCode.testkit.ts` — Keep protocol fake; cut duplicated semantics and improve targeted fidelity

The fake lets the real SDK encode/decode HTTP while tests script sessions/messages/forms/tools/streams and VM crashes. That is stronger than mocking SDK callbacks and is shared by meaningful worker tests. Split scenario builders from the HTTP router if navigation is difficult; do not build a second OpenCode implementation. Use upstream wire schemas/types for scripted records where practical instead of broad Json casts that accept impossible state. Keep unsupported requests loud.

Material fidelity gaps: session/shell lists never paginate although production code must; repeated prompt IDs only skip insertion, while real native behavior around repeated delivered prompts is subtle; create always replaces the root instead of reporting conflict; form answers are accepted without field validation; session outcome/usage/title details are simplified. Add only the cases needed to verify server behavior. The fake's isSettled duplicates ChatRepository's rule, which risks both implementation and test being wrong together; treat its behavior as an upstream fixture, not an oracle for the same algorithm. Per-test construction can eliminate the large reset method and cross-file leakage. Preserve stream cancellation/boot-linked clearing and observable receipts; do not replace them with sleeps.

### `src/runner/RunnerClient.testkit.ts` — Keep observable fake; improve fidelity selectively

Models inventory, outage, refusal, boots and workspaces and records what the server requested. Keep receipt/removal signals over sleep-based synchronization. reset's Object.assign-plus-preserved-collections boilerplate disappears with per-test fixture construction. Production ensureChat keeps an existing VM setup fixed, but the fake overwrites runner.chats setup on every ensure call; make that behavior match the runner so retry/setup tests cannot falsely pass. Inventory is an independently scripted field rather than derived from chats; be explicit in runner-page tests or derive a default inventory. Removed VMs leave chatFiles behind in the fake, unlike real deletion; clear them to test restoration/lifecycle honestly. No need to emulate VM infrastructure or add tests of every fake setter.

### `src/runner/RunnerClient.ts` — Keep boundary; simplify required config and naming

The sole production adapter for runner models/inventory, VM lifecycle, file/workspace transfer and proxied OpenCode endpoints. Keep per-operation timeouts, typed unavailable/refused/oversize errors and redacted tokens. Required URL/token are currently parsed with empty defaults then rejected through a defect; use required validated Config values and an ordinary startup config failure. Validate the URL once instead of stripping slashes from arbitrary text. `chatServer` necessarily exposes an unwrapped password to the SDK, so keep that value out of traces/errors. The repeated timeout/catch plumbing is readable and small; a generic HTTP method registry would obscure endpoint-specific errors. A focused adapter test should exercise real HTTP/error mapping; current testkits alone cannot prove timeouts or typed wire refusals are mapped correctly.

### `src/scheduledTasks/webhookRoute.ts` — Keep raw bounded route; refine failure mapping

Accepts raw methods and body, caps the body at `WEBHOOK_MAX_BODY_BYTES`, keeps the secret token out of what the service sees, and maps outcomes to fixed HTTP responses. Keep token-free path construction and fixed error bodies. A body read that fails for any reason answers 413 (`body_too_large_or_unreadable`); distinguish malformed/disconnected reads from an actual 413 if senders depend on the status. The service call's `catchCause` also catches interruption and then manufactures a response after the caller left. The debug cause log may still contain request URLs or credentials despite the public response being safe; redact at that boundary. No route-annotation helper should reintroduce the secret URL into spans.

### `src/scheduledTasks/webhook.ts` — Keep the small template language and signature check; bound expansion

Renders a webhook's prompt from path lookups and explicit whole-body/request placeholders, with aggregate headers and query redacted and explicitly named fields raw, and checks an HMAC-SHA256 signature over the raw body. Keep that distinction: indiscriminate redaction would change requested agent input, while indiscriminate raw expansion would leak secrets; own-property lookup prevents prototype traversal. A `query` placeholder builds a new `URLSearchParams` for every occurrence; parse it once per render. A small template repeating `{{body}}` can expand far beyond the body cap before the 120,000-character refusal; bound output while rendering. `constantTimeEquals` hashes both strings, so its time still depends on their length even though the final compare is fixed-length; state the real guarantee. `verifySignature`'s comment says GitHub, Linear, Shopify and most other senders sign only the raw body; some schemes include timestamps or canonical strings, so keep the supported scheme explicit rather than adding vendor modes speculatively.

### `src/server.ts` — Keep the layer groups

Owns the actual HTTP server, domain layer graph, routes, logging and worker activation. The named layer groups are useful; do not replace them with a generic service registry. Router segment length and zero preemptive shutdown delay address real transport constraints. Imports/layer wiring are large but not business logic to move into domain services.

### `src/workflows/BoardAccess.test.ts` — Keep both boundaries; move file case to content suite

Board access restricted to overseers and uploader/overseer-controlled file removal are useful independent behaviors. Keep them. The second case has little to do with board access; move it to a StepContent/service scenario file if one is created, without duplicating the fixture. Extend file removal to assert metadata/current field cleanup when changing field-file behavior, rather than checking only the missing read. Slug collision policy belongs with definition tests, not repeated in every board visibility case.

### `src/workflows/fallbacks.ts` — Keep reassignment policy; separate reads from notification effects

Resolves unavailable assignees/responsibles through step, workflow and oldest active workflow admin, notifying affected people/admins. This prevents orphaned work, so blanket deletion would remove real business behavior. `stepResponsible` looks like a query but can insert notifications; name the effect or return a resolution plus notices so read-only preview paths do not mutate unexpectedly. Keep unread-notice deduplication, ideally enforced with an atomic insert/unique condition rather than check-then-insert races. Batch notifications and active-recipient checks. Ref comparisons like `sameRef` recur inline in MemberDeactivation and WorkflowItemService: consolidate a couple of pure ref helpers, not a generic identity hierarchy. The missing-admin defect protects an asserted invariant; test the invariant's enforcement rather than adding arbitrary fallback recipients.

### `src/workflows/helperProposal.ts` — Share field validation

Validates helper values/repeating-group proposals and renders a source-attributed final explanation. Keep propose as the source-attributed final explanation and finish signal; it remains useful alongside direct writes. `resolve`/`fits` duplicate field traversal and value validation from structure/item mutation; share one canonical value/path validator so helper and human writes accept the same dates/numbers/options. Current date validation only checks the YYYY-MM-DD shape, and number validation accepts nonfinite numbers if called without contract decoding. Validate duplicate field/group paths and source references where the caller requires them. Resolve a proposal's keys once instead of traversing again for problem checks, labels and rendering. Do not invent a generic template engine for the explanatory comment.

### `src/workflows/ItemRepository.ts` — Keep transactions' building blocks; simplify projections/decoding

Owns item/step persistence, fields and comments. Keep audit authors on writes. `openItemValues` and `fieldValues` duplicate JSON decode loops; share one decoded value projection. Most other rows are unchecked interfaces; derive schemas where meaningful instead of asserting SQL output types. `saveItem`/`saveStep` replace all mutable columns from a snapshot, so they must remain inside the command engine's transaction; narrower conditional updates are preferable for independent concurrent actions. Stable tie-break IDs should accompany position/timestamp ordering. Keep explicit deletion cascades coordinated through services, rather than blindly adding more cascading foreign keys. No need for a repository per table.

### `src/workflows/MemberDeactivation.test.ts` — Keep fallback matrix; observe the permitted leave

Last-active-admin protection, open-worker and pending-approver fallback, oldest-admin responsibility, future-step inheritance, send-back to a departed worker and nested-step fallback protect different lifecycle paths. Keep them. The first last-admin test ends immediately after the permitted leave: assert persisted inactive membership and remaining active admin so the successful reverse path is observable. Remove the accountant fixture member only where genuinely unused rather than replacing useful named role scenarios with positional users.

Workflow-definition notifications and responsibility selection are worth asserting together, as done here. A blanket “deactivation is covered by the organization's tests” would miss these downstream effects. Preserve the test-clock separation proving longest-serving admin selection. Session revocation belongs to the organization's tests rather than being duplicated here.

### `src/workflows/MemberDeactivation.ts` — Keep transactional participant; batch item reads

Reassigns live work, cancels helpers and notifies affected people while vetoing deactivation of a last workflow admin. The transaction participation is essential. Workflow records are already cached during the operation; join items/workflows for all involved steps to remove the remaining per-item read loop. Extract the shared ref helpers from WorkflowItemService so this narrow participant need not import the large command module. Keep done-work attribution untouched and rollback on protected-admin failure.

### `src/workflows/NotificationRepository.ts` — Keep; make deduplication/retention explicit

Persists per-user notices, joins navigation labels, counts unread and marks reads by both notification ID and owner. Preserve owner scoping and same-time rowid ordering. The hasUnreadNotice-then-insert sequence used by fallbacks can race; provide atomic insert-if-no-unread or a matching partial unique constraint for whole-workflow notices. List limit bounds responses but not table growth; choose a read-notice retention policy if the service runs long term. Reuse a decoded row schema, and avoid selecting unused columns in count/existence reads. No reason to merge notifications into the item engine's file merely because inserts happen there.

### `src/workflows/NotificationService.ts` — Keep small; simplify read marking

Authorizes active users, caps visible history at 50 and resolves step labels against the item's version with a request-local structure cache. Keep detail access independent: a notification does not grant permission to open its step. `markRead` UPDATE then GET can be one owner-scoped UPDATE RETURNING; describe one row with a helper instead of creating a one-element array then defending against an impossible empty mapped array. Notifications use the item's current version for labels, so version moves can relabel historical notices; snapshot labels only if historic fidelity is required. The list cap and total unread count can diverge when more than 50 unread notices exist; ensure users have a way to clear/read the older ones before changing retention. Avoid adding push/email machinery in a cleanup.

### `src/workflows/StepContentService.ts` — Keep narrow file/comment access; simplify shared engine dependency

Owns authorized comments, attaching uploads to a step, carried-file reads and removal. Keep “carried current field value” checks, which prevent a later step downloading arbitrary files from another item or unrelated earlier content. Freeform comments/uploads allow contributions according to visibility, while file-field writes require the active worker and working state; preserve that distinction. File removal currently allows the uploader or workflow overseer and checks field-step state but not item-open state; ensure cancellation/completion has the intended edit policy. Reduce imports from the full item engine to shared context/access/mutation helpers without weakening transaction boundaries.

### `src/workflows/StepHelpers.test.ts` and `StepHelpers.integration.test.ts` — Keep helper authority/privacy; consolidate setup and fix overclaims

Helper call-in authority, inactive-item restrictions, helper replacement and rejected proposals now run against repository/directory test layers without SQLite. Configuration, privacy, field writes, lifecycle changes and persisted outcomes remain integration tests. Together the suites protect nonversioned helper configuration, omit-versus-clear, child-specific helpers, archived-agent refusal, caller/stopper roles, human ownership, inactive-item restrictions, selection privacy, source-rich proposals, invalid/grouped proposals, direct field-write authority, immediate stop revocation, single active helper, retries, refreshed briefs, mutation guards and deactivation. These are distinct business rules worth retaining. Keep direct helper writes and denied assigned-only tools together: removing the old “read-only helper” assumption is intentional. Proposal-only calls leaving fields unchanged is still valid for that operation, but the comment saying “The helper changes nothing but its comment” should describe propose specifically, not the helper's overall capabilities.

Merge “The helper's comment is seen like any comment…” into the proposal scenario with authorized/outsider reads, or rely on the existing generic comment visibility tests once an actual agent-author case remains. Remove incidental docReader≠payslipReader and paolo≠giulia assertions. The first test publishes the open item onto v2 before checking the helper, so it does not prove “every version” by itself; describe live/nonversioned people rather than claiming multiple retained versions were inspected.

“The helper reads … nothing else” only checks an empty description and expected lists, without sensitive other-item/step sentinels. The deselection scenario meaningfully checks excluded description/comment/attachment/input, but leaves instructions=true and fieldValues=true; it does not prove deselected instructions or field values stay private, especially ancestor instructions. Strengthen that real boundary when changing selection. “Helpers … work side by side” only links two chats sequentially and reads their briefs; rename to independent queued work or move execution concurrency proof to the runner suite. The mutation-guard case writes permitted content but does not read it back, so its “content can” claim needs persisted values/comments assertions.

The fail-note assertion spreads the received object back into the expected object; use an explicit projection/objectContaining for the fields that matter. None of these observations justifies discarding the suite wholesale.

### `src/workflows/StepViewService.ts` — Refactor shared assembly context; preserve selective visibility

Builds individual step and overseer-only whole-item views, including carried fields, files/comments, helper/agent chat and ancestor/substep navigation. Keep the deliberate hiding of an item's unrelated current step from ordinary participants. The service and makeStepViews each construct an item engine, and a whole-item read rebuilds values/ancestors per top-level step. Build one request-scoped item context with indexed steps/values/attachment metadata and reuse it. File fields currently perform a metadata query per occurrence; batch referenced attachment IDs. Shared toAttachment/toComment and read-only context helpers belong in a small projection module rather than importing mutation machinery across services. Opening a step marks its notifications read before view construction succeeds; mark only after a successful view if “seen” should mean delivered. Keep raw file bytes out of this view. Do not replace participant-aware views with a full-item response filtered in the browser.

### `src/workflows/structure.ts` — Keep pure model; index traversal once per operation

Owns structural validation, step lookup/version compatibility, nested/repeating field paths, required-field completion, UI/agent field trees and carried input fields. This is coherent domain code, although definition traversal and field-value traversal could become two private modules if navigation suffers. `findStep` builds a complete node list on every call; compute a step-key index once for overview/version-move requests and reuse it. Global uniqueness of all field and step keys is stricter than step-local storage requires; keep it unless changing publication semantics deliberately. Keep parent-first traversal, bounded group depth and the difference between false/zero and missing values. `isFilled` assumes stored values were validated; it checks presence rather than revalidating select/date/number content. Ensure all writes use the same validator rather than adding repeated defensive validation here. `FieldTree<X>` is a justified small reuse for view/brief output, not a reason to generalize the entire form engine. Carried fields scan all values repeatedly; pre-index by step when assembling large briefs. Bound substep depth/count at schema/validation input to avoid recursive traversal limits; current group-depth limits do not bound step nesting.

### `src/workflows/versionMove.ts` — Keep business impact model; index definitions and use stable grouping keys

Computes draft changes, item move blockers, missing earlier fields and reopening consequences used by publication UI and execution. Keep preview rules shared with actual movement, particularly parent changes/removal blockers and required fields on prior steps. Repeated findStep/fieldsByKey/sibling scans can be replaced with per-version indexes computed once. Impact aggregation groups by display names/labels , so distinct steps with identical names can be merged; use stable step/field keys internally and include labels only for presentation. The diff compares field type/options/repeatable but does not report field description or field-parent/path changes; ensure preview accurately explains all transformations that actual move applies. `openItemRef` falls back to an item ID as a step ID when no step exists; return an explicit nullable navigation target rather than an invalidly typed fallback if that state is possible. Do not cut version-move safeguards because most workflows are small; they prevent loss of populated fields and unintended completion.

### `src/workflows/workflowAccess.ts` — Keep policy; make active-state assumptions explicit

Shares a person's parts in a step (`partsIn`) and the active-member, workflow-admin/responsible, board-viewer and valid-assignee checks. Keep the one visibility model for step views, fields, comments and files. `isAdmin` checks active state only for organization admins; a listed workflow admin returns true even if inactive, assuming callers already used requireActive. Either enforce active state inside the predicate or name/type it so that assumption cannot be missed by new callers. `oversees` likewise matches the responsible by id alone, without their state. Reduce repeated person/admin reads within one request by sharing a resolved access context; avoid global permission caches. The returned access helper is sufficient; a hierarchy of permission services would add ceremony.

### `src/workflows/WorkflowAgents.test.ts` — Keep human fallback and agent authority; remove repeated give-up fixture

Covers entering queued agent work, successful handoff to approval, failure/give-up notes and human reassignment, workflow-level responsibility fallback, handing the step back to the agent, reassignment invalidating old agent writes, brief contents/files and publication updating current instructions. These are substantial domain checks. Keep both successful approval fallback and failed fallback: they exercise different outcomes. Merge “The agent gives up with a note” into the earlier fails/gives-up table, which already asserts the note, human assignee and failed state; the second checker fixture adds no distinct guarantee. My work assertions can share the first success lifecycle without duplicating the WorkQueries matrix.

The human takeover scenario is particularly useful despite removal of dedicated takeover UI: ordinary reassignment must revoke the old chat's authority. Brief tests inspect filenames but not returned bytes, and do not prove item-description propagation; extend their observable outputs rather than adding prompt-string snapshots. Retain the publication/instruction case because it establishes the intended live-version behavior for a step handed back to its agent.

### `src/workflows/WorkflowAgentService.ts` — Keep the helper/assignee distinction; define late proposals

Owns field writes, completion/failure fallback and helper call/stop/proposal. Keep helpers distinct from assigned agents: helpers may fill fields while the human keeps completion responsibility; only assigned agents use the general comment/attach/done tools. Retain the final proposal as a sourced explanation and finish signal. `propose` should also define behavior when its item/step stops being actionable. Keep conditional terminal transitions and failure notices idempotent.

### `src/workflows/WorkflowArchive.test.ts` — Keep lifecycle distinction; combine first/third scenarios

No new items, existing work continues, unarchive restores starts, published definitions cannot be deleted, draft deletion and nonadmin denial are meaningful. Combine archive→start refused→unarchive→start succeeds into one scenario to remove duplicate setup, while keeping running-work continuation separate. “Only a never-published workflow can be deleted” and “admin deletes draft” can be one publish-state table if that remains readable. Remove unused seeded Elisa where a second admin is irrelevant. Do not cut reverse actions or published-history retention tests.

### `src/workflows/WorkflowDefinitionService.test.ts` — Keep policy/rollback; cut repeated field round-trips

Reviews creation/admin ownership, initial-draft validation without partial creation, draft editing, assignments/instructions/substeps, publication gates, required responsibility, admin membership/removal, permission matrix, organization-wide access, field/step validation, slugs. Preserve the real permission, last-admin, collision and invalid-draft rollback checks. The “adds, orders, removes” case only asserts the final two-step save; either assert each intended order/removal persisted or remove the unobserved intermediate writes/title claims.

Use explicit actor keys in the permission table instead of parsing human-readable `who` strings and casting. Remove redundant person helper in favor of the testkit and incidental archival/deletion from the admin-membership scenario already covered by WorkflowArchive. The organization-admin list test has a distinct important access rule; it can merge with the matrix only if visibility remains asserted. Slug collision with a real ID and explicit clearing are valuable, as are default transfer/clear and org-admin-only changes. Current defaults are tested on unpublished/private workflows, so the absence of open/published default requirements is intentional tested behavior unless changed deliberately. “Nest to any depth” currently proves depth three only; use bounded wording or explicit supported limits rather than claiming recursion is unlimited.

### `src/workflows/WorkflowDefinitionService.ts` — Keep publication transaction; simplify list/detail reads

Owns definition drafts, previews/publication, nonversioned assignments, board configuration, admin membership and archive/delete policy. Publishing atomically creates a version and moves every open item with the item engine; preserve that behavior and fail the whole publication on move blockers. `movingItems` already batches values/steps and caches version structures, a useful pattern to reuse. Missing referenced versions currently become empty structures (`movingItems`); treat impossible missing versions as an integrity error instead of a valid empty workflow. Preview is advisory and publication recomputes it under transaction, which correctly avoids trusting stale UI consent.

Simplify list visibility into one summary query with management flags instead of three full-draft reads and in-memory deduplication/sorting. `detail` rereads the workflow after requireAdmin loaded it; accept the known record where safe. `setPeople` should verify that submitted stable step keys exist in the intended draft/published definitions, rather than silently accumulating arbitrary orphan settings. `archive`/`unarchive` can share a small internal setArchived helper; no benefit in separate archive services. Retain active-last-admin protection and never-published-only deletion.

### `src/workflows/WorkflowDirectory.ts` — Keep read boundary; batch membership/role lookups

Provides narrow organization/agent reads to workflows without mutating those domains. Keep this domain view rather than reaching through the organization's handlers. Repeated person calls in visibility can be batched per request; do not introduce a cross-request cache that retains deactivated permissions. Keep oldest-active-admin ordering for deterministic fallback and the SQL last-admin check.

### `src/workflows/WorkflowGroups.test.ts` — Keep nested-value and file lifetime checks

The invalid group-shape table, nested repeatable rows, incomplete-row gate, removed-row value erasure, and carried file access/removal exercise behavior not covered by simple scalar-field tests. Keep all of those dimensions. The long add/fill/remove case is a coherent lifecycle, not justification for splitting every setField call into a test. If it becomes difficult to diagnose, separate schema rejection from valid-row lifecycle while preserving re-added rows having empty values. The second file scenario checks metadata deletion and empty views but not physical bytes; verify physical cleanup when changing storage deletion. The final “not working” assertion is weaker than the exact successful state expected from self-approval; assert the real outcome. The “shape” helper is useful projection, though its comment claims labels it does not include; fix the comment rather than adding redundant label assertions.

### `src/workflows/WorkflowItemService.test.ts` — Keep transition outcomes; consolidate duplicate entry/publication setup

Tests draft/published separation and immutable old version, no-op publication refusal, unpublished start refusal, automatic open-item movement, latest-version starts, nonversioned people versus already-entered people, step assignments, completion gates/options, approval/rejection/self-approval, last-step completion. Keep those rules. Remove “An item has no assignee”: asserting absent object keys mirrors the DTO shape and repeats the preceding assignment/current-step check without new user behavior.

Publication increment/latest/open-item tests can reuse one edited-workflow scenario while preserving old-version immutability and already-entered people; the larger version-move suite should own complex transformations. The completion-gate test fills the field then refuses because a child remains open, so it does not independently prove missing-field refusal despite its title; split/check both gates if changing completion. Approval waiting and moving-on can be one end-to-end scenario; self-approval and rejection remain distinct. Keep stored/read-view outcomes instead of adding tests for each extracted engine method.

### `src/workflows/WorkflowItemService.ts` — Highest-value decomposition

This file contains both the item command service and a 40-method shared engine used by queries, content, views, agent capabilities, publication and deactivation. The engine is a broad bundle of repository access, projection helpers and transitions; consumers construct it repeatedly and import a large command module just for helpers such as stepName. Extract pure actor/record projections, a small item context/access loader, field mutation/validation and the publication move procedure. Keep the transition engine's transaction owner explicit. Avoid replacing it with a generic state-machine framework or exporting every private helper as a service.

The following groups were reviewed separately:

- Entry/assignment: require an explicitly assigned first step; later steps inherit the previous actual assignee when unassigned. Retain step responsibility → workflow responsibility, deactivation fallbacks and recursive defined substeps. `enterStep` rebuilds an existing step from defaults and resolves current people; check the “people never change except explicit commands/deactivation” comment against this re-entry behavior. Refactor with a table of intended entry/re-entry semantics.
- Fields/groups: keep finite-number validation, false/zero completion, row-membership checks, atomic row/file cleanup and helper field-write permission. Share date/value validation with helper proposals; YYYY-MM-DD shape alone accepts impossible dates. Bound/validate group row IDs so dots/reserved segments cannot ambiguously alter field paths. File writes correctly use the attachment capability rather than setField.
- Completion/approval: keep required fields plus approved children before markDone, self-approval only for the same person, rejection notes and the hand-back to an assigned agent after rejection. Plain block state is a flag rather than a completion gate; document that if intentional. `unblock` lacks the working-state check applied by block, so it can mutate an awaiting/passed step; align or explicitly permit that reverse action.
- Agent briefs: `brief` and `briefFileIds` each load the same field values, ancestors, carried fields and attachments; share one brief context and batch attachment reads. Own file-field bytes are not included by the freeform-file loop unless carried from earlier steps; verify every file named in a brief is accessible. Selection excludes item title/description together but ancestor instructions remain even when instructions are excluded; make this privacy contract explicit.
- Navigation/send-back: retain preserved field values/comments and approved child history while clearing later approvals and stopping obsolete agent chats. Reuse one loaded/indexed step tree; descendants, ancestors, version moves and each result currently perform repeated SQL walks/full-item reads. Guard malformed cycles or enforce bounded depth at creation.
- Publication/version move: the procedure repeatedly rereads steps/values and versions inside one transaction. Compute a move plan from a stable loaded item, then apply it. Keep atomic deletion of removed-field files, added-substep entry, missing-passed-field send-back policy and reopening approval when new work appears. Preserve nonversioned people settings.
- Item lifecycle/metadata: retain reasoned cancellation, manager due dates, and reopen-to-latest with fresh fallback assignments.

Every public mutation currently wraps a transaction, which protects read/check/write invariants. Preserve that before removing repeated checks or narrowing SQL writes. Backend-only agent actors bypass member-state checks by design; expose them only through the step's linked chat, not an arbitrary agent ID supplied by another transport.

### `src/workflows/WorkflowLifecycle.test.ts` — Keep reverse transitions and permission failures; remove repeated projections

Send-back target validation, reason requirements, cleared approval with retained values, current-worker permission, blocking, cancellation/reopening, manager-only due dates and date ordering are substantive behavior. Keep those. Merge “The send-back reason is recorded as a comment on the target step” into the earlier send-back scenario by adding its author assertion; it repeats the same action and comment lookup. Block→unblock and cancel→reopen can each share a scenario without losing their before/after outcomes. Keep denial cases distinct from successful mutation, preferably as small role/input tables.

The blocked/rejected My work flag cases repeat the earlier blocking scenario and the rejection check in WorkflowItemService; place each assertion with the actual transition and remove these extra fixtures. The generic row-field case overlaps WorkQueries and the due-date scenarios; retain a single authoritative row-shape assertion rather than repeating item/workflow/step labels across suites. Preserve ordering of dated and undated work and overdue calculation, which test query semantics beyond storing a date. Use the test clock for any additional date-boundary case.

### `src/workflows/WorkflowNotifications.test.ts` — Keep notification matrix; merge identical read paths

The five arrival scenarios protect notification delivery for assigned work, approval, rejection, send-back and failed agents. These outputs differ from My work placement, so retain the matrix. Replace the prose-string switch with explicit scenario builders/data where that reduces repeated setup; do not build a generic test DSL. Keep “Changes in Waiting notify nobody,” which protects against premature approver notification. The two final tests both call the same stepView method on the same assigned step and check the same unread transition; the distinction between clicking a notification and My work exists only in fixture lookup here. Merge them into one test asserting the notification's target, the returned step and unread count before/after. Neither is an actual browser-navigation test.

### `src/workflows/WorkflowRepository.ts` — Keep persistence scope; separate summary projection from full drafts

Persists definitions, immutable published versions, nonversioned people/admin settings, slugs and archive state. Every list currently selects/decodes full draft JSON and computes unpublishedChanges even when `toWorkflow` immediately strips both. Add a lightweight summary projection for lists, retaining full records for definition editing/publication. Derive/validate row types instead of unchecked actor-kind casts. Replace string `where` fragments with SQL fragments where practical; values are currently parameterized, so do not mislabel this as direct user SQL injection.

Several multi-statement methods (`insert`, `publish`) rely on an outer service transaction. Make that contract explicit or own the transaction here so a new caller cannot create a workflow without its first admin. Keep immutable copied draft text; publication text equality is valid only because serialization is stable and the published version copies that exact text. Avoid broad INSERT OR IGNORE for admins. `resolveId` intentionally prefers exact IDs over slugs and slugTaken protects collisions with both; preserve both behaviors. The optional helper omission versus explicit null is meaningful patch semantics, not redundant branches to cut.

### `src/workflows/WorkflowResponsible.test.ts` — Keep role distinction; trim the board snapshot

Protects the difference between overseeing work and administering definitions: a responsible can see/manage items and cannot edit workflows. Keep those rights/denials. The full board layout overlaps WorkflowBoard; assert visibility plus canManage=false and item outcome instead of duplicating column names/order. Seed only needed people; several named fixture users are unused in each case. The multi-action delegate/date/cancel/reopen case is appropriate as a role matrix, but detailed lifecycle semantics should stay in the dedicated suite rather than being repeated here.

### `src/workflows/Workflows.testkit.ts` — Simplify aliases; avoid copying business behavior

Builds real workflow layers over isolated SQLite and offers domain-shaped seeds/inspection. Keep publishWorkflow through real definition methods and deterministic dates. `addHelperAgent` only forwards addAgent; remove this alias and simplify callers. `leave` manually copies production deactivation ordering rather than using the organization's deactivation: retain it for focused participant tests, but do not let it stand in for integration coverage of the real deactivation transaction. Fixture constructors use lowercase names as IDs, so explicit IDs avoid accidental collisions in tests that compare display-name changes. Prefer public view/outcome assertions over inspecting every stored field; repository inspection remains justified for snapshots/queue/idempotence guarantees invisible in UI. Move shared projection helpers out of production command modules without turning the testkit into an alternative domain implementation.

### `src/workflows/WorkflowSteps.test.ts` — Keep reassignment/nesting; simplify fixtures

The reassignment permission matrix, rejected mutation leaving the assignee unchanged, per-item isolation and human→agent queueing have value. Keep them. Definition-owned substeps need their own hierarchy/privacy checks, actual assignee inheritance, independent completion, parent gate and agent responsibility fallback. The standalone default-assignee case can merge with nested My work/view setup. The parent-completion test leaves multiple children unfinished, so it does not isolate “done but unapproved” from “still working”; change its setup before relying on that specific guarantee. A three-person comment visibility table is useful role coverage; it need not repeat a full view snapshot.

Trim unused fixture users.

### `src/workflows/WorkflowVersionMove.test.ts` — Keep publication safety matrix; merge weak/no-extra-state cases

This suite protects the complicated publication behavior: preview versus actual migration, leave-empty/send-back choice, reopening passed/current approval work, incompatible current/nested steps, deleted values/files, skipped earlier additions, reorder/rename distinction, finished/cancelled history, reopening onto the latest version, current people, nested agent work, preview staleness, authorization and transaction rollback. Most cases warrant keeping. The forced SQLite failure after an earlier item update is particularly valuable: it proves the publication and preceding mutations roll back together. The late-arriving-item case correctly verifies publication re-reads rather than trusting a stale preview.

Merge the first added-field preview with “Moving puts the item on the new version…” and assert the actual carried name plus new tax-code value=null: the latter's title currently claims emptiness without inspecting it. “A step an item went through can't move under another step” checks only preview labels, so add rejected publication/preserved state or narrow the claim. The earlier simple “new current field must be filled” can merge into the later approval-reopening case, which checks the same missing-field gate plus recovery; retain a working-state row only if it exercises a distinct branch. Remove incidental giulia≠paolo assertions, which validate fixture naming rather than product behavior.

The removed-file case's title promises physical byte deletion, but its assertions only check missing metadata and authorization failure; inspect storage in the test before relying on physical cleanup. It also does not read back the surviving ordinary attachment. Preserve skipped past children versus new children on send-back as separate paths, and cancelled/reopen-compatible versus incompatible rollback as separate outcomes. Replace non-null assertions with explicit fixture expectations where failure would otherwise become an unhelpful TypeError. Avoid collapsing this suite into generic diff snapshots: the resulting work state is the important guarantee.

### `src/workflows/WorkflowVisibility.test.ts` — Keep content privacy; consolidate repeated denied reads

This suite protects meaningful distinctions: board oversight versus step participation, a participant's earlier step versus another step/item, worker versus workflow/org admin, carried field values/files versus ordinary attachments, and nested-step views. Keep these security and data-flow outcomes; checking encoded response content here is legitimate observable privacy testing, not scanning implementation source. Three admin identities need not repeat the full item snapshot: keep one detailed authorized result and table-drive access for creator/co-admin/org-admin. Likewise, combine the first other-step denial with the later comment-privacy setup, retaining both absence of comments and denied direct access.

The rejection-comment case can move into the existing reject lifecycle test, adding author/kind/body there and removing a whole duplicate workflow fixture. Ordinary attachment isolation and carried-file access must stay distinct: they intentionally have opposite sharing semantics. “Opening a row shows only that step” overlaps the earlier private-step case but additionally checks nested-step summary and field visibility; merge that dimension only if those checks survive.

### `src/workflows/WorkQueries.test.ts` — Keep section matrix; simplify fixture dispatcher

The five situations independently check worker/substep/approver/agent-waiting placement, and finished work disappearing is an essential reverse transition. Keep the matrix. Its switch reconstructs complete workflows with repeated people per case; a compact data table of assignment/state/expected section is clearer than prose-literal dispatch. Avoid computing the expected section from the same predicates as production. Check agent label in the agent-waiting case, since currently only section/name is asserted. If broader lifecycle tests already check disappearance, one representative section-exit case here is enough; don't duplicate it for every section.

### `src/workflows/WorkQueries.ts` — Keep list projections; remove N+1 ancestry lookups

Builds My work sections and board columns from durable steps, with role access and due/blocked/rejected status. Keep list payloads light and defer full step content to detail requests. Reuse a single typed joined step projection rather than two almost identical SELECT column sets. Parent names walk SQL one ancestor per row (`parentNames`); fetch/index all necessary steps once and guard against malformed cycles. Cache agent labels within a read just as structures already are. Board assembly filters all steps per column; group once by current step key. Dates currently define “today” in UTC; changing to local/user time is product behavior, so state and test the intended boundary. Both boards and My work are unbounded result sets: pagination/limits should be planned together with UI consumption, not hidden server truncation. Pure helpers such as stepName should move out of the large mutation module to avoid query→command coupling.

### `tsconfig.json` — Simplify include scope

Keep the shared configuration and Node types. `integration` is included although the inventory contains no such directory; remove the stale entry. `../../scripts/lib` includes the entire shared script folder in this package's typecheck; narrow it to imported build/config helpers or rely on import traversal, after checking that the root scripts project owns those files. No behavior change is needed.

### `vite.config.ts` — Evaluate test isolation

The remaining test-policy question is the inherited `isolate: false`: it saves startup but makes globals/module mocks leak across files. Measure its benefit before changing it; prefer isolation if the saved time is small, rather than accumulating test workarounds.
