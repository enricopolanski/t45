# Cleanup pass

Requested explicitly, so it lives in the repo despite the "no plans" rule in AGENTS.md. Every tracked file was listed (`git ls-files | sort`, 1,639 outside `.repos/`, which is vendored and read-only) and walked directory by directory in that order. Files were read where a scan flagged them: leftover terms (providers, desktop/mobile, worktrees, forks, version skew…), modules only their tests import, exports nobody uses, and producers or consumers that no longer exist. The rest were skimmed by header. Only scanned and skimmed, not read line by line: `apps/web/src/components/{ui,work,workflows,home,chats,agents}` and `apps/server/src/{workflows,org,scheduledTasks}`. Sections follow the walk; only files with a possible improvement, cut or leftover are listed.

Each entry names the file and what could change. Delete an entry once it is done or decided.

## apps/server/src/attachments

- `apps/server/src/attachments/AttachmentRepository.ts` — the store keeps every file's bytes under the server's state directory (`attachmentsDir`). Add a cloud implementation that keeps them in an object-storage bucket behind the same service.

## apps/server/src/chats, opencode

- `apps/server/src/chats/ChatExecutions.ts` — tool-file discovery still scans `dist/runtime` at service construction, branches on the source filename and reads every `.mjs` chunk even when no chat uses T45 tools. Supply built tool assets explicitly from an entry manifest, keeping execution persistence independent of directory scanning without adding another service hierarchy; this is also recorded in `todo.md`.
- `apps/server/src/chats/ChatService.ts` — `open` reads a `messages` change's rows when it sends the change, not when the worker published it, so on a slow link a copy can reach the browser after deltas that streamed before the copy was read, and show their text twice until the next copy. Sending the rows with the change alone isn't enough: `open` subscribes before reading its snapshot, so a buffered older row would land after a newer snapshot; order snapshot and changes together.
- `apps/server/src/chats/ChatService.ts` — a later input no longer checks the chat's agent, so archiving an agent only stops new chats with it, and members keep writing in their existing ones. Decide whether those chats should freeze again, with the composer saying why.
- `apps/runner/src/ExecutionOrchestrator.ts` — every session gets permission rules allowing everything but questions for working agents, and OpenCode merges session rules after the agent's and takes the last match (`.repos/opencode/packages/core/src/permission.ts`), so they override the `webfetch`/`websearch` deny the runner writes into `opencode.json` on the provider-only network; only the network policy still stops them. Send the deny with the session rules for those chats, or drop the session rules.
- `apps/runner/src/ExecutionOrchestrator.ts` — there is no per-chat storage quota: only the disk is capped, not the messages and attachments T45 keeps.
- `apps/runner/src/ExecutionOrchestrator.ts` — a subagent session the agent removes inside its VM stays in `known`, so `readForms`, `readSession` and `done` call OpenCode for it and get `SessionNotFoundError`, which fails the execution, though `docs/internals/chats.md` says a removed subagent keeps what the runner read of it.
- `apps/server/src/chats/ChatService.ts` — `docs/internals/chats.md` says a delete cleanup cut short is finished at the next server start, but no startup path reads tombstoned chats.
- `apps/runner/src/ExecutionOrchestrator.ts` — an input re-sent when a new input starts a chat after failure, or when server startup recovers a running chat, can repeat committed workflow side effects. Discarding output does not undo those effects, and newly generated tool-call IDs bypass the receipt ledger.
- `apps/runner/src/ExecutionOrchestrator.ts` — nothing retries a VM whose removal failed, so it runs until its chat's next execution replaces it or the runner restarts.

## apps/runner

- `apps/runner/src/ExecutionOrchestrator.ts` — the reader keeps per-session cursors, unfinished sets and the message ids events name (`PendingReads`) to read only what changed. Rereading every session whole per event batch would drop that bookkeeping, but each pass would then re-send the whole conversation through the unbounded output queue and upsert every message; measure `saveMessages` and the transfer on long chats before choosing it.
- `apps/runner/src/ExecutionOrchestrator.ts` — nothing tests the execution logic since the scripted OpenCode fake went, and a fake would need the seam provided by the removed `SandboxManager` service.
- `apps/runner/src/ExecutionOrchestrator.ts` — `Stream.callback` creates an unbounded output queue before the RPC transport's bounded queue, so messages, file events and heartbeats can accumulate while T45 consumes them slowly. Give output a bounded buffering policy that preserves durable event order and stream backpressure without adding another acknowledgement protocol.
- `apps/runner/src/ExecutionOrchestrator.ts` — the runner doesn't check the path or size of a file T45 puts in a VM; review whether it should.
- `apps/runner/src/ExecutionOrchestrator.ts` — the runner has no cap on VMs running at once (the env caps and `RunnerBusyError` were removed). When capacity matters, have the runner compute what it can take from its own resources and tell T45 when it can't start another VM, instead of hardcoded counts.

## apps/server/src/org

- `apps/server/src/org/http.ts` — avatars are served `no-cache` without a validator, so every page load downloads them again. Version their URL by upload time instead of `updatedAt` and serve them `immutable`.

## apps/server/src/persistence

- `apps/server/src/persistence/Schema.ts` — at the first release, freeze the schema as the baseline and add an append-only migration ledger applied on top of it, so released databases upgrade instead of being refused.

## apps/server/src (tests, workflows)

- `apps/server/src/chats/ChatExecutions.ts`, `apps/server/src/workflows/WorkflowService.ts`, `apps/server/src/tasks/TaskService.ts` — `allowQuestions: false` disables OpenCode's blocking question tool but does not communicate or guarantee unattended work: an agent can ask a question in plain text and end its turn. A step task then fails without submitting, while a non-step automation can be marked succeeded just because the execution ended normally. Derive execution instructions and interaction capabilities from the same server-side context: explain that no human will answer during execution, which assumptions are allowed, and how to report a blocker. Keep the question-tool restriction when no answering channel exists, and define completion checks appropriate to each task instead of treating normal execution completion as sufficient proof of success. Keep task policy on the server; the runner only applies the supplied capabilities.
- `apps/server/src/workflows/WorkflowService.ts` — nothing bounds a step's chat now that the run deadline is gone: each refused call starts a new turn, so an agent that keeps repeating one loops without end, and a background shell left running keeps the chat running, so its step never settles.
- `apps/server/src/workflows/WorkflowService.ts` — the brief travels inline in the chat input, so the chat refuses a step whose carried values or comments pass 120,000 characters, or that carries more than 100 files: handing it to an agent falls back to its responsible in the same command. Send the brief as a file next to the step's files, and spread more than 100 files over several inputs.

## apps/web/src/components (ChatView)

- `apps/web/src/**/*.tsx` — "render this or nothing" is written two ways: `x ? <X /> : null` at most sites, and `x && <X />` at the error-text sites. Adopt `&&` as the one form and convert the ternaries in a mechanical commit of their own. Keep `&&` to guards that are booleans, strings or objects: a number leaks into the DOM, since `0 && <X />` renders a literal 0.
- `apps/web/src/components/chat/ChatTimeline.tsx` — split the timeline into focused component files, with `TimelineCtx` and its shared type in a separate module.
- `apps/web/src/components/markdown/Markdown.tsx` — consider showing site favicons next to links again (now a globe or the GitHub mark). The removed version fetched them from Google's favicon service, which disclosed every linked domain and needed a private-host filter; prefer a source that leaks nothing, such as the server fetching and caching them.
- `apps/web/src/components/markdown/CodeBlock.tsx` — consider tinting code blocks and file chips by language again, in CSS only: code blocks would need a `data-language` attribute again, so `.chat-markdown-codeblock:is([data-language="ts" i], [data-language="typescript" i])` can set a `--code-tint` the header reads; file chips would need a `data-file-name` attribute to match with `[data-file-name$=".py" i]`. Decide where the color goes (label text, a dot or a border; label text needs a contrast check in both themes) and keep it to the common languages, since models write several aliases for each.

## apps/web/src (hooks, lib, rpc, state, root modules)

- `apps/web/src/router.ts` — test TanStack's built-in stale-route-chunk recovery with old tabs across production deployments in Chromium, Firefox, and WebKit: startup and navigation failures, hover preloads, successful reload recovery, persistent missing chunks without reload loops, and blocked `sessionStorage`.
- `apps/web/src/state/session.ts` — replace `useSession` with a `useUser()` that returns the signed-in `User` model, never null, since the shell only mounts once the gate admits a session: let the signed-in `AuthSessionState` carry the `User` (the session handler reads it with `UserRepository.get`), keep it in the root route's context with the admitted gate state, and drop the `?.` and `?? ""` fallbacks at its seven callers and `AccountMenu`'s directory lookup of the user's own name and avatar. Role changes and deactivation end the session, so only the user's own profile edits need to refresh it.
- `apps/web/src/timestampFormat.ts` — the time-format setting is gone, so times follow the browser locale. Check whether anyone needs a 12/24-hour choice back, and whether the English-only tooltip date ("4th June 2026") should follow the locale too.

## docs

- `docs/planning/backlog.md` — its one item ("Authenticated local verification") is about the Clerk-only door blocking browser checks; this pass did it with a throwaway script that mints a dev session in a scratch home. Turn that into a documented dev command or keep the item.

## patches, scripts

- `vite.base.config.ts`, `package.json` — consolidate formatting, linting, and typechecking into `vp check`. Align Vite+'s Oxlint/tsgolint versions with `@effect/tsgo` support, enable the Effect Oxlint integration (`effect-tsgo patch --oxlint`) and `lint.options.typeAware`/`typeCheck`, and verify that every workspace package and the existing Effect diagnostics remain covered before removing the separate typecheck from pre-commit. Replace the stale integration comment once verified.
- Dev runs two servers (Vite serving the page with live reload, proxying `/api` to the T45 server) while production runs one. Move to a single server in both, e.g. the T45 server hosting Vite in middleware mode, and drop the proxy in `apps/web/vite.config.ts` and the split ports.

## packages/contracts

- `packages/contracts/src/models/Skill.ts` — the checks in its schemas (the name pattern, `FilePath`, no SKILL.md) have no tests; review whether they need some.
- `apps/web/src/components/agents/SkillEditor.tsx` — the form edits file rows and builds `files` as a record on save, so two rows with the same path silently keep only the last. Decide whether `SaveSkillRequest.files` should be a list with unique paths that the server turns into the record.
