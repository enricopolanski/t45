# Open follow-ups

Keep unresolved work and design questions here; remove an entry when it is implemented or decided. Tool packaging, replayed workflow effects and real-VM verification have one checklist in [todo.md](../../todo.md). Current decisions belong in [internals](../internals/); commits and PRs record delivered changes.

These are follow-ups from the earlier cleanup reviews, with references updated to the current source; proposals still need checking when picked up, and are not instructions to add abstractions, retries, limits or tests indiscriminately.

## Chats and execution

- `apps/server/src/chats/ChatService.ts`: order snapshots, message copies and deltas consistently. A queued message invalidation reads its rows at delivery time, so the copy can contain text already streamed in earlier deltas. Capturing rows when publishing is insufficient on its own: subscription starts before the initial snapshot, which must not be overwritten by an older queued copy.
- `apps/server/src/chats/ChatService.ts`: decide whether archiving an agent should prevent new inputs to its existing conversations; currently it prevents only new conversations. If that policy changes, explain the unavailable state in the composer.
- `apps/server/src/chats/ChatService.ts`: narrow display truncation to known large content fields instead of every long string and every property named `data`; preserve the original stored message and whole-message access. Preserve answer attachment ownership if native answer validation refuses the request.
- `apps/runner/src/ExecutionOrchestrator.ts`: session permission rules override the provider-only `webfetch`/`websearch` denies from `SandboxManager.ts`, leaving network enforcement as the only restriction. Align the rules so the agent sees the capabilities its network actually allows.
- `apps/runner/src/ExecutionOrchestrator.ts`: handle a deleted subagent consistently with the retained history contract. Its ID remains in `known`, and subsequent reads can fail with `SessionNotFoundError`; deleting the root must still fail its execution.
- `apps/runner/src/ExecutionOrchestrator.ts`: evaluate whether reading complete sessions per event batch can replace `PendingReads`, cursors and unfinished-message bookkeeping. Measure long-chat transfer and `saveMessages` work first; a smaller reader that repeatedly sends and upserts the full conversation may cost more overall.
- `apps/runner/src/ExecutionOrchestrator.ts`: the output queue created by `Stream.callback` is unbounded before the RPC transport's bounded queue. Evaluate backpressure at that boundary while preserving event order and independent reply-file writes, without another acknowledgement protocol.
- `apps/server/src/chats/ChatExecutions.ts`: disk replacement precedes the SQL commit, so interruption between them leaves the disk ahead of the stored output, as [Chats](../internals/chats.md#the-disk) describes. Decide whether a disk pointer changed in the commit is worth the extra storage lifecycle.
- `apps/runner/src/SandboxManager.ts`: saved ext4 archives keep deleted blocks; check whether guest `fstrim` reduces archive size before changing the save procedure.
- When deployment size warrants it, decide per-chat storage policy and runner admission based on actual capacity; the VM disk bound does not bound T45's stored messages and attachments, and there is no concurrent-VM admission policy.

## Workflows and agents

- `apps/server/src/chats/ChatExecutions.ts`, `apps/server/src/tasks/TaskService.ts`, `apps/server/src/workflows/WorkflowService.ts`: `allowQuestions: false` only disables the blocking question tool. Define unattended instructions and completion criteria together: no human will answer, which assumptions are allowed, and how to report a blocker. A step task fails without submission, while a non-step automation currently succeeds on normal execution completion. Keep task policy on the server and supplied capabilities in the runner.
- `apps/server/src/workflows/WorkflowService.ts`: large task context or more than 100 attachments can exceed the ordinary chat input limits and prevent a task from starting. Evaluate a context file and an attachment delivery path that preserves one task input's meaning instead of silently omitting context.
- Starter agents are editable organization-owned definitions after initialization; decide separately whether any supplied agents should instead be application-owned capabilities updated with releases. Prepared images could package an agent definition's environment, instructions, model, skills and tools, but should share the definition and execution path used by custom agents. Revisit when different runtime dependencies or release-owned behavior are actually needed; credentials and host permissions remain runtime configuration.
- `apps/server/src/workflows/WorkflowService.ts`: batch repeated attachment metadata, definition and actor reads within a view or command when measurements justify it; preserve one transaction per command and avoid permission caches across requests.
- `apps/server/src/workflows/WorkflowService.ts`: validate that default-assignment keys refer to steps in the workflow's definition rather than retaining orphan settings.
- `apps/server/src/workflows/WorkflowService.ts`, `apps/server/src/workflows/NotificationRepository.ts`: consider combining owner-scoped notification marking and reading; decide retention and how users reach unread notices beyond the list limit. Keep marking read tied to an explicit notification action.
- Plan pagination for chat lists, My work and boards together with their UI consumers when those lists become large; do not silently truncate server results.

## Storage, authentication and HTTP

- `apps/server/src/attachments/AttachmentRepository.ts`: add an object-storage implementation when local attachment storage is no longer appropriate, keeping the same ownership rules.
- `apps/server/src/attachments/http.ts`: replace manual attachment-ID extraction from a wildcard route with a route parameter if the router supports the trailing filename; retain private access and safe download headers.
- `apps/server/src/org/http.ts`, `apps/server/src/org/avatars.ts`: version avatar URLs by image change rather than every profile update, then use immutable caching instead of downloading on each page load.
- `apps/server/src/auth/http.ts`: review `Secure` cookies for HTTPS deployments and `no-store` on session responses; preserve local HTTP development.
- `apps/server/src/auth/Authentication.ts`: consider a shared claim decoder after signature verification while retaining issuer, expiry, verified-email and optional `azp` policy; validate the decoded Clerk hostname as a bare host, and validate the runner URL at its configuration boundary.
- `apps/server/src/auth/Authentication.ts`: expired session rows are rejected but retained; choose a retention policy when needed without changing the session TTL or post-commit revocation behavior.
- `apps/server/src/org/Users.handlers.ts`: decide whether ordinary members should receive pending and deactivated users from `users.list`, or only an active directory.
- `apps/server/src/chats/ChatRepository.ts`, `apps/server/src/org/UserRepository.ts`: review unchecked SQL row annotations such as message and avatar rows when changing their persistence boundaries; keep decoding local rather than adding a schema layer for every query.
- `apps/server/src/automations/webhook.ts`: parse query parameters once per rendered prompt, and decide how expansion should behave when repeated placeholders exceed the eventual prompt limit; preserve explicit raw-field access and aggregate credential redaction. Correct the constant-time comparison comment: hashing still depends on input length, and the supported signature scheme is HMAC over the raw body, not every provider's protocol.

## Web

- `apps/web/src/**/*.tsx`: choose one form for rendering optional content; a mechanical conversion to `&&` must avoid numeric guards rendering `0`.
- `apps/web/src/components/chat/ChatTimeline.tsx`: evaluate focused private components and shared context only if they make the timeline easier to follow; more files are not themselves an improvement.
- `apps/web/src/components/markdown/Markdown.tsx`: decide whether link favicons are useful enough to restore, without disclosing every linked domain to a third-party favicon service.
- `apps/web/src/components/markdown/CodeBlock.tsx`: consider CSS-only language colors for code blocks and file chips, with readable contrast and a small set of language aliases.
- `apps/web/src/router.ts`: verify stale-route-chunk recovery across production deployments in Chromium, Firefox and WebKit, including preload failures and persistent missing chunks without reload loops.
- `apps/web/src/state/session.ts`: consider exposing the admitted `User` through route/session context so signed-in consumers need no nullable fallbacks or extra self-directory lookup; retain session revocation on role/state changes and refresh after profile edits.
- `apps/web/src/timestampFormat.ts`: decide whether to restore a 12/24-hour preference and whether English tooltip dates should follow the browser locale.
- `apps/web/src/components/agents/SkillEditor.tsx`: duplicate file paths currently collapse to the last row when converted to a record; decide how the editor should report that before saving.

## Development and verification

- Provide a reusable authenticated local-browser workflow in [Development](../operations/development.md). Clerk configuration is documented and disposable checks have used a locally seeded session, but there is no maintained command for that fixture flow; the original claim that authenticated local verification is impossible is obsolete.
- `apps/server/src/persistence/Sqlite.ts`: evaluate moving the cached schema-image/test-database construction out of production persistence, retaining measured setup savings and independent connections.
- `apps/server/src/persistence/Sqlite.test.ts`: replace the child lock-holder's timer with an observable release handshake and scoped process cleanup.
- Inventory existing server tests by business invariant and future model/frontend-e2e home before removing them. Retain input replay, rollback, private-content access and session-revocation guarantees; remove duplicate helper assertions only when their behavior is still covered. The new workflow controls and assistant have disposable verification but no new permanent regression tests, by instruction.
- `vite.base.config.ts`: measure the value of `isolate: false` before keeping test workarounds for shared module state.
- `vite.base.config.ts`, `package.json`: evaluate consolidating format, lint and typechecking into `vp check` once Vite+/Oxlint and Effect diagnostics cover every workspace; do not drop the separate typecheck before parity is established.
- Consider one server in development and production, with Vite middleware in development, if it removes more proxy/port plumbing than it adds.

## Retained design scenarios

[User management](./users/user-management.feature) and [workflows](./workflows/workflows.feature) retain the original scenarios, including future ideas; they are not a verified description of the current implementation. Reconcile the workflow scenarios before using them as acceptance criteria: they still describe agent assignees and helpers, an assigned first-step requirement, notification reads on opening a step, ticket-only substeps and deferred workflow drafting, which the current design has superseded.
