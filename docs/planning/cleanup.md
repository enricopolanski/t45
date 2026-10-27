# Cleanup pass

Requested explicitly, so it lives in the repo despite the "no plans" rule in AGENTS.md. Every tracked file was listed (`git ls-files | sort`, 1,639 outside `.repos/`, which is vendored and read-only) and walked directory by directory in that order. Files were read where a scan flagged them: leftover terms (providers, desktop/mobile, worktrees, forks, version skew…), modules only their tests import, exports nobody uses, and producers or consumers that no longer exist. The rest were skimmed by header. Only scanned and skimmed, not read line by line: `apps/web/src/components/{ui,work,workflows,home,chats,agents}` and `apps/server/src/{workflows,org,scheduledTasks}`. Sections follow the walk; only files with a possible improvement, cut or leftover are listed.

Each entry names the file and what could change. Delete an entry once it is done or decided.

## apps/server/src/attachments

- `apps/server/src/attachments/AttachmentRepository.ts` — the store keeps every file's bytes under the server's state directory (`attachmentsDir`). Add a cloud implementation that keeps them in an object-storage bucket behind the same service.
- `apps/server/src/runner/RunnerService.ts` — `putFile` only logs when the server lost a file or the runner refuses it, but `promptText` and `answersWithAttachmentPaths` still name its path, so the agent looks for a file that isn't in `/work/attachments`. Have `putFile` report what it put, and say in the prompt, or in a note for files re-put at restore, which files didn't arrive.

## apps/server/src/chats, opencode

- `apps/server/src/chats/ChatService.ts` — `open` reads a `messages` change's rows when it sends the change, not when the worker published it, so on a slow link a copy can reach the browser after deltas that streamed before the copy was read, and show their text twice until the next copy. Send the copy the reconcile read with the change instead.
- `apps/server/src/chats/ChatService.ts` — a later input no longer checks the chat's agent, so archiving an agent only stops new chats with it, and members keep writing in their existing ones. Decide whether those chats should freeze again, with the composer saying why.
- `apps/server/src/runner/RunnerService.ts` — `setBoot` is the boot's last write, so a T45 that dies after restoring a new boot but before recording it restores again into the same running VM on restart: `/work` goes back to the last save and attachments are put again.
- `apps/server/src/runner/RunnerService.ts` — capture commits a page of messages before `hooks.saved` applies their step calls in a second transaction, and nothing replays stored messages after a restart (`recoverTask` only calls `ended`, and a re-capture passes on only the rows that changed), so a T45 that stops between the two loses those calls: a lost `step_done` fails its task as "ended without submitting". Replay the stored messages of active step tasks through `saved` at startup; the `task_calls` ledger already skips the applied ones.
- `apps/server/src/opencode/OpenCode2Client.ts` — every session gets `sessionRules` (allow everything but questions for working agents), and OpenCode merges session rules after the agent's and takes the last match (`.repos/opencode/packages/core/src/permission.ts`), so they override the `webfetch`/`websearch` deny the runner writes into `opencode.json` on the provider-only network; only the network policy still stops them. Send the deny with the session rules for those chats, or drop the session rules.
- `apps/server/src/opencode/OpenCode2Client.ts` — a message over the 64 MiB per-answer cap (`RESPONSE_MAX_BYTES`) gets no placeholder: capture fails on it and the chat's worker keeps retrying. Nor is there a per-chat storage quota: only the workspace is capped, not the messages and attachments T45 keeps.

## apps/runner

- Nothing has run on a real microsandbox VM yet (`apps/runner/src/MicrosandboxChats.ts`): check the workspace `tar` running as the agent, `/tmp` permissions for the workspace upload, and VM removal.
- `apps/runner/src/ChatTable.ts` — the runner has no cap on VMs running at once (the env caps and `RunnerBusyError` were removed). When capacity matters, have the runner compute what it can take from its own resources and tell T45 when it can't start another VM, instead of hardcoded counts.
- `apps/runner/src/MicrosandboxChats.ts` — agent files are written into `/work` beside what every boot writes itself (`AGENTS.md`, `opencode.json`, `attachments/`, `.opencode/skills/`), and `agents.create`/`agents.update` no longer refuse those paths. Have the runner place agent files where they can't collide.

## apps/server/src/persistence

- `apps/server/src/persistence/Schema.ts` — at the first release, freeze the schema as the baseline and add an append-only migration ledger applied on top of it, so released databases upgrade instead of being refused.

## apps/server/src (tests, workflows)

- `apps/server/src/workflows/WorkflowService.ts` — nothing bounds a step's chat now that the run deadline is gone: each refused call starts a new turn, so an agent that keeps repeating one loops without end, and a background shell left running keeps the chat running, so its step never settles.
- `apps/server/src/workflows/WorkflowService.ts` — the brief travels inline in the chat input, so the chat refuses a step whose carried values or comments pass 120,000 characters, or that carries more than 100 files: handing it to an agent falls back to its responsible in the same command. Send the brief as a file next to the step's files, and spread more than 100 files over several inputs.

## apps/web/src/components (ChatView)

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
