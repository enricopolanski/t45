# Runner simplification review

Every piece of runner-adjacent code was asked one question: can it be simpler if we drop the made-up edge case it handles? Two skeptics then challenged each candidate: one looked for a realistic scenario that needs the code, the other for another feature that depends on it. Nothing has been changed.

The skeptics knocked out only 4 of 98, so treat this as a list of candidates, not decisions. Candidates found more than once are merged. **harness-flagged** marks security checks whose removal the harness flagged as weakening security, and **boundary check** marks input validation at the runner's edge; neither is an edge case.

## Index

The list is about 55 distinct mechanisms in 9 groups:

- **VM inventory, VM states and the admin VM list:** 32, 28, 34, 75, 83, 27, 63. One decision: does the runner expose anything beyond whether it is available?
- **Leftover-VM mechanisms:** 17, 18, 20, 21, 25, 26, 73, 76. These are alternatives, not separate deletions. 73 relies on microsandbox removing ephemeral VMs after the runner dies, which nobody has checked.
- **Runner re-checking T45's writes (security):** 33, 60, 74, 19, 62, 71, 24.
- **Catching and continuing, and timeouts:** 1, 3, 4, 8, 54, 11, 57, 12, 50, 51, 52, 58, 59, 77, 81.
- **Stop, cancel and pending-input races:** 5, 7, 13, 15, 16, 39, 43, 78, 85, 45, 48, 61, 80.
- **Schema and status leftovers:** 36, 42, 44, 38, 40, 41, 46, 9, 35.
- **Fakes and tests only:** 2, 64, 65, 66, 67, 68, 69, 70, 72.
- **Defensive code unrelated to fresh VMs:** 6, 10, 14, 22, 23, 29, 30, 31, 37, 47, 49, 53, 55, 56, 82, 84. These came from the "made up" criterion, not from the design change, so the whole group can be skipped.
- **Docs:** 79.

Line numbers are from the tree during the run, and you have since changed `RunnerService.ts`, `TaskService.ts`, `ChatService.ts`, `ChatRepository.ts`, `ChatHooks.ts` (deleted), the integration test and `chats.md`.

## Server: RunnerService, PromptService, handlers

1. `apps/server/src/runner/RunnerService.ts:454`: catching RunnerRefusedError on put/getChatWorkspace and continuing, which handles Runner refusing to unpack or pack the VM's own /work tarball (~16 lines).
   - Why it can go: Either refusal means the runner failed on a tarball it produced itself, or the fresh VM vanished in a precisely timed window. Continuing is worse than failing: after a refused unpack the execution runs on an empty /work and its finish overwrites the saved tarball, and after a refused pack it commits a conversation whose files weren't saved. Letting the refusal end the execution as 'failed', as startChat's refusal already does, uses the existing path.
   - Change: Both catchTags blocks go, along with the `content.byteLength > 0` guard in finish.
2. `apps/server/src/runner/FakeOpenCode.testkit.ts:50`: fake knobs unansweredPrompts and files, which handles A prompt hits an unanswering VM; the agent leaves files to read (~12 lines).
   - Why it can go: No test sets either knob. unansweredPrompts served the removed 'keeps trying while the VM doesn't answer' test, whose scenario hang/crash now cover (d), and files is never populated, so readFile always answers 404.
   - Change: The unansweredPrompts set and its 502 branch in /prompt go, along with the files map, its wipe loop and the lookup, leaving the fs/read route as a fixed 404.
3. `apps/server/src/runner/RunnerService.ts:617`: SessionNotFoundError catches in captureSession, readForms, done inbox; known.delete, which handles Agent or plugin removes a subagent session through OpenCode's API (~10 lines).
   - Why it can go: Nothing in T45 or OpenCode's own subagent lifecycle calls session.remove. Per docs/internals/chats.md, only something holding the server's password does, which needs the agent to misuse the API (b). A removed root already fails the execution, and a removed subagent can fail it the same way.
   - Change: The three SessionNotFoundError catchTags (captureSession's root-vs-subagent branch with known.delete, readForms' succeed([]), done's inbox succeed([])) go, and so does the 'removed inside the VM' trap paragraph in the doc.
4. `apps/server/src/runner/RunnerService.ts:697`: getChatWorkspace RunnerRefusedError catch with empty-bytes sentinel and byteLength check, which handles Runner refuses to pack /work at finish (tar fails or times out) (~8 lines).
   - Why it can go: The design's finish is 'save /work, then commit', and the generic failure path already covers a step that doesn't complete: output is discarded and the chat becomes failed (c). The catch instead commits a conversation whose /work changes are silently lost, even though the doc records it as deliberate.
   - Change: The catchTags block, the `new Uint8Array()` sentinel and the `if (content.byteLength > 0)` guard go, so finish always saves what getChatWorkspace returned, and the doc sentence about a refused save is dropped.
5. `apps/server/src/runner/RunnerService.ts:726`: done() gated on `woken || marked.activity` (Marks.activity, woken flag), which handles Skip done() on event batches that can't end OpenCode's work (~6 lines).
   - Why it can go: done() short-circuits on its first two checks (unsent inputs in SQL, then session.active) while anything runs, so it already answers 'not done' cheaply (c). The gate also adds a hidden case: woken starts true so an execution with nothing to send can finish.
   - Change: Marks.activity, the two `marks.activity = true` assignments (the shell branch becomes `return true`), `let woken` and its reassignment go, and the loop checks done every iteration.
6. `apps/server/src/runner/PromptService.ts:46`: null checks on attachmentPath / files.path for AttachmentId-typed ids, which handles Attachment id that isn't a valid AttachmentId (~6 lines).
   - Why it can go: Every caller here passes ids already decoded as AttachmentId (ChatAttachment.id, boundTo rows), so the path-traversal null can't occur (b/c); RunnerService already builds the VM path by plain concatenation.
   - Change: The null checks go in formatAnswers, appendAttachmentPaths and putFile: PromptService builds `${ATTACHMENTS_DIRECTORY}/${id}`, and files.path returns string for AttachmentId.
7. `apps/server/src/runner/RunnerService.ts:691`: finish maps root outcome 'interrupted' to chat status interrupted, which handles Root session outcome interrupted inside a fresh VM (~5 lines).
   - Why it can go: OpenCode marks an execution interrupted only through session.interrupt, a session removal, or its own restart. T45 calls none of these, and OpenCode never restarts inside a VM that lives for one execution (a/b); a stop removes the VM and never reaches finish.
   - Change: The nested ternary becomes `info.outcome === "failed" ? "failed" : null`, end's status narrows to "failed" | null, and ChatHooks.ended plus TaskService's dead running/waiting/interrupted early return narrow with it.
8. `apps/server/src/runner/RunnerService.ts:326`: putFile PlatformError catch (attachment bytes missing on server), which handles Bound attachment's file missing from the server's disk (~5 lines).
   - Why it can go: T45 removes an attachment's bytes only when no chat holds it (release, detach and sweep all require unheld), so a file bound to a running chat is missing only after outside tampering (b).
   - Change: The PlatformError handler goes, and readFile gets orDie (or the error type joins ChatVm.putFiles); the RunnerRefusedError handler stays, because step files of 50-64 MB can reach the runner's 50 MB limit.
9. `apps/server/src/runner/RunnerService.ts:163`: AgentGoneError class and agent === null check in attempt, which handles The chat's agent row was deleted (~5 lines).
   - Why it can go: No code deletes agents (only archive or restore; no DELETE FROM agents anywhere). chats.agent_id REFERENCES agents(id) with PRAGMA foreign_keys = ON (Sqlite.ts:21), so an agent with chats can't be removed at all.
   - Change: The 6-line AgentGoneError class goes, the check becomes a die (or the lookup an orDie), and 'a gone agent' leaves chats.md.
10. `apps/server/src/runner/PromptService.ts:72`: recordsById ambiguity handling (duplicate contextId maps to undefined), which handles Input context with duplicate contextIds from a caller bypassing schema (~4 lines).

- Why it can go: ChatMessageContext's filter rejects duplicate contextIds, and every payload format sees is schema-decoded: chats.send from RPC, stored inputs via InputPayload in inputsOf. No internal caller builds a context (c).
- Change: The loop and its comment become `new Map(records.map((record) => [record.contextId, record]))`.

11. `apps/server/src/runner/RunnerService.ts:171`: CONNECT_TIMEOUT on awaiting server.connected, which handles Event stream opens but never sends server.connected (~3 lines).

- Why it can go: server.connected is the stream's first frame, and the stream already fails after SilentStreamTimeout (45s, checked per pull) with no byte. That fails the `connected` Deferred before the 60s timeout can fire (c); heartbeats without connected would be OpenCode breaking its contract (b).
- Change: The constant and the timeoutOrElse pipe go, leaving `yield* Deferred.await(connected)`, and the doc's 'within a minute' clause goes too.

12. `apps/server/src/runner/RunnerService.ts:172`: VM_TIMEOUT on withVm and cancel, which handles VM's OpenCode hangs one request while its event stream stays alive (~3 lines).

- Why it can go: A VM that stops answering goes silent, so the stream timeout ends the execution and its VM removal fails in-flight proxied requests. OpenCode hanging one endpoint while its stream stays alive is a contract break (b) that the execution's own untimed calls don't guard against either.
- Change: The constant and the two Effect.timeout(VM_TIMEOUT) pipes go.

13. `apps/server/src/runner/RunnerService.ts:304`: inputLocks RcMap per chat (withInputs), which handles Cancel with no execution racing a newly started execution's deliver (~3 lines).

- Why it can go: The lock only excludes deliver, which runs only inside an execution, and an execution's first deliver follows a VM start that takes seconds. A cancel that finds no execution has nothing to race (b), so a semaphore on the Execution covers the real case.
- Change: The RcMap and withInputs go, and a `lock` field is created with the Execution; deliver takes execution.lock, and cancel takes it only when an execution exists.

14. `apps/server/src/runner/PromptService.ts:137`: appendAttachmentPaths drops references past MESSAGE_MAX_INPUT_CHARS, which handles Text near the 120,000-char limit plus file references overflow it (~3 lines).

- Why it can go: post already refuses an input whose formatted text exceeds the limit (inputRefusal on format(...).length), so this check only turns that refusal into the agent silently losing file paths (c).
- Change: The fit check, its doc comment and the MESSAGE_MAX_INPUT_CHARS import go, and references are always appended.

15. `apps/server/src/runner/RunnerService.ts:852`: cancel's leading pendingInputs check, which handles Cancel of an input the agent already took (~2 lines).

- Why it can go: The two existing checks already return false for a taken input (c): the inbox-cancel plus message.get finds it taken when it was sent to this VM, and deletePending re-checks pending otherwise.
- Change: The first pendingInputs read and its early return go.

16. `apps/server/src/runner/RunnerService.ts:834`: stop always publishes an 'inputs' change, which handles stop changes which inputs are pending (~1 lines).

- Why it can go: Pending inputs change only when discard deletes uncommitted user messages, and discard then publishes 'replaced', which already sends a full snapshot including inputs.
- Change: The publish(chatId, "inputs") line in stop goes.

## Runner: VM lifecycle

17. `apps/runner/src/ChatTable.ts:191`: 'stopped' state, entry kept until remove succeeds, no-entry remove-by-name, which handles a failed removal stays listed so T45 retries it next start (~35 lines).

- Why it can go: It exists only to feed a retry of failed removals at T45's next start, which the user accepted won't happen; the no-entry branch reaches VMs of an earlier runner process, which the boot sweep and `.replace()` already clear, since T45 only ever lists entries this table holds; entryFor's initial 'stopped' is overwritten under the lock.
- Change: remove becomes: no entry, return; otherwise under the lock forget the entry and destroy the VM, logging a failure; the state loses 'stopped' (entryFor starts at 'starting'), and with it the contract literal, the UI 'Stopped' badge, the fake's failRemove knob, the 'stays listed' test and http.ts's 'so T45 tries again' comment.

18. `apps/server/src/runner/RunnerService.ts:874`: server-start sweep: inventory then removeChat each, which handles VMs left running when T45 restarts while the runner stays up (~27 lines).

- Why it can go: The chats it reruns get their old VM replaced by `.replace()` in their own startChat (agents are only archived, so an owed chat always reaches startChat), and a DB wipe is cleared by the runner's own boot sweep since dev restarts both; that leaves only VMs whose removal failed (accepted: never retried) and a chat that committed or was tombstoned when T45 died in the milliseconds between finish's commit and its removeChat finalizer (a made-up timing).
- Change: start becomes Deferred.succeed(started, hooks) then wake each owed chat, dropping the inventory call, per-VM removeChat loop and both warning branches, and the integration test's scripted inventory and removedChats assertion; if the user wants the guarantee kept, one runner remove-everything call replaces list-then-remove-each.

19. `apps/runner/src/ChatTable.ts:93`: runningEntry state check before write/pack/unpack, which handles a file or workspace call for a chat whose VM isn't running (~16 lines).

- Why it can go: MicrosandboxChats.held already fails the same call when no VM is held, and ChatTable maps that to a refusal; T45 only writes between its startChat and removeChat, and the one race (an answer's putFile during a stop) is refused and logged the same either way.
- Change: runningEntry and its three calls go; the 'isn't running' refusal assertions in the files and workspace tests go too, since the fake doesn't check.

20. `apps/runner/src/ChatTable.ts:103`: `release` via tapError on a failed start, which handles A VM that failed to start, possibly booted, is left behind (~14 lines).

- Why it can go: T45's attempt registers its removeChat finalizer before it calls startChat, so every failed or dropped start is followed by removeChat. That call waits on the entry lock and removes both the VM and the entry, so the runner's own release does the same job again and leaves a `stopped` entry listed until T45's remove arrives.
- Change: The `release` helper and `Effect.tapError(() => release(entry))` in start go; the 'fails to start is removed' test checks removal after T45's remove instead.

21. `apps/runner/src/MicrosandboxChats.ts:257`: find by name + SandboxNotFoundError catch in removeNamed, which handles removing a VM this runner process doesn't hold (~11 lines).

- Why it can go: Every VM this process makes is in `started` and Sandbox has destroy(); VMs of an earlier process are the boot sweep's, a same-name leftover is replaced by `.replace()`, and a retry after a failed remove is the accepted gap. This depends on dropping removeNamed in start and the keep-listed retry, and started.set must move to right after the SDK create, or a VM whose writeAgentSetup fails can no longer be removed.
- Change: find, its catchIf and the SandboxNotFoundError import go; removeNamed becomes: take the held Sandbox out of `started` and destroy it if there is one.

22. `apps/runner/src/MicrosandboxChats.ts:116`: encodeOpenCodeConfig schema check of opencode.json, which handles OpenCode refusing the opencode.json the runner writes (~6 lines).

- Why it can go: Its only variable part, mcpServers, was already decoded with OpenCode's own ConfigMCP.Server schema when RunConfig was decoded at the runner's HTTP boundary; the rest is a constant typed as Config.Info's encoded shape, and a refusal would still surface as 'OpenCode did not start.'
- Change: JSON.stringify(openCodeConfig(chat)) replaces the schema encode, its SandboxError mapping and the Schema import.

23. `apps/runner/src/MicrosandboxChats.ts:384`: acquireUseRelease kill of tar on release, which handles tar still writing after T45 drops the save request (~4 lines).

- Why it can go: T45 drops getChatWorkspace only on its timeout or a stop, and both end the attempt and remove the VM, tar with it; the exec also has its own 90 s timeout, and on success the kill hits an exited process.
- Change: acquireUseRelease becomes the execStreamWith call piped into readTarball, without the release or its comment.

24. `apps/runner/src/MicrosandboxChats.ts:412` **harness-flagged** **security**: random upload name for the workspace tarball, which handles something in VM plants a link at the upload path (~2 lines).

- Why it can go: Restore runs in a brand-new VM before any input is sent, so no agent code has run yet; only admin-configured MCP servers could race it, and they are the agent's own sandbox anyway.
- Change: randomUUIDv4 becomes a fixed /tmp path.

25. `apps/runner/src/MicrosandboxChats.ts:374`: removeNamed(name) before create in start, which handles a same-name VM still exists when a chat's VM starts (~1 lines).

- Why it can go: create's builder already calls `.replace()`, which per the SDK SIGTERMs (then SIGKILLs) and replaces any sandbox of that name, running or stopped, so the lookup-and-destroy just before it does the same job twice.
- Change: start becomes create, started.set and serve; the `yield* removeNamed(name)` line goes and `.replace()` alone handles a leftover of the chat.

## Runner: HTTP, proxy, config

26. `apps/runner/src/server.ts:43`: runner's own start-up sweep beside an in-memory inventory, which handles sandbox records left by an earlier runner process (~25 lines).

- Why it can go: The design says only T45 removes VMs, with leftovers waiting for T45's next start. The runner sweeps on its own only because the inventory T45 sweeps from is ChatTable's in-memory map, which forgets an earlier process's VMs. VMs of executions T45 still runs are already removed by name at its next removeChat or startChat, so two sweeps cover one case (c).
- Change: layerHousekeeping, ChatSandbox.sweep and its microsandbox and fake versions go; inventory instead lists labelled sandboxes from microsandbox (with a chat-id label), so T45's start-up loop removes them, and ChatTable.remove no longer keeps a failed removal's entry listed.

27. `packages/contracts/src/resources/RunnerVms.ts:41` **boundary check**: opaque VmId (up to 200 chars), isChatId guard, maxParamLength 512, which handles Runner listing a VM whose id isn't a chat id (~18 lines).

- Why it can go: Only T45 calls the runner, and it starts at most one VM per chat, always named by the chat's UUID. A non-chat vmId would need the only caller to break its own contract. Typing the param as ChatId makes Runner.handlers' isChatId guard unnecessary, and the router's default maxParamLength of 100 already fits a 36-char UUID.
- Change: VmId becomes ChatId. Runner.handlers drops isChatId, its Schema import and the check. The runner drops routerConfig and its two uses. The integration test's 'orphan' vmId becomes a UUID.

28. `packages/contracts/src/resources/RunnerVms.ts:43`: inventory VM state starting/running/stopped and its badge, which handles telling a VM kept stopped between executions from a serving one (~16 lines).

- Why it can go: "stopped" was the old model's VM kept between executions (a). Now a listed VM is either its running execution's or a failed removal, and T45's start removes those whatever their label. Only the admin badge reads the state, and "starting" lasts only for the boot.
- Change: The state literal and field, the web VM_STATES map and badge, and ChatTable's three-valued Chat.state go (server !== null already means running); entries of failed removals stay listed, and only the stopped assertion in ChatTable.test changes.

29. `apps/runner/src/http.ts:60`: health precheck in the startChat handler, which handles a VM start on a host without KVM (~15 lines).

- Why it can go: Without KVM, microsandbox's create fails and ChatTable refuses the start anyway, so T45 marks the chat failed either way, and the inventory already shows the KVM reason on the runner page. The trade-offs: the server log loses the KVM wording, docs/internals/sandboxed-chats.md records the precheck as a decision, and I could not verify that create fails fast without KVM.
- Change: The six-line precheck and the start-refusal half of http.test's no-KVM test go; the inventory's health stays.

30. `apps/runner/src/chatProxy.ts:76`: HEAD handling and bare /opencode path normalization, which handles T45 sending HEAD or a path-less /opencode request (~2 lines).

- Why it can go: The OpenCode client has no HEAD calls (none in the @opencode/client dist), and every call it makes has a path under /api, which the /opencode/* route already requires. 204 stays covered by BODYLESS.
- Change: The HEAD conditions in hasBody and the empty-response branch go, and the empty/query-only path normalization goes.

31. `apps/runner/src/chatProxy.ts:45` **boundary check**: carriesToken accepts Bearer as well as Basic, which handles a proxy caller sending the runner token as a bearer (~1 lines).

- Why it can go: The proxy's only caller is the execution's OpenCode2Client.connect, which sends Basic. T45's bearer-mapped client is only the RunnerHttpApi client, and no test sends Bearer to the proxy.
- Change: The Bearer alternative goes, leaving a single Basic comparison.

## Contracts and runner settings UI

32. `packages/contracts/src/resources/Runner.ts:14`: RunnerStatus.vms per-VM chat list on the runner page, which handles Admin inspecting long-lived chat VMs and what uses each (~75 lines).

- Why it can go: It was built for VMs that outlived turns: its text still says 'The VMs the runner has seen since it started' and 'No chat has run since the runner started', and its connections/lastActiveAt are already gone. Now a VM lives for exactly one execution, so the list only repeats which chats have status running or waiting, flickers under the 5 s poll, and the page offers no VM action.
- Change: RunnerStatus shrinks to {isAvailable, reason}. Runner.handlers loses the per-VM chat join (ChatService and AgentRepository deps, isChatId, access checks). RunnerSettings loses the Chats section, the RunnerVm type, VM_STATES and vmDetails, and the server-auth doc line goes.

33. `apps/runner/src/ChatTable.ts:151` **harness-flagged** **security**: runner's writeFile size and attachments/ path re-validation, which handles T45 sending an oversized file or a path outside attachments/ (~35 lines).

- Why it can go: Only T45 calls putChatFile, always with a stored attachment that passed the upload size limit, at `attachments/<id>`. The same caller already writes arbitrary content into the disposable VM's /work through putChatWorkspace and agent files, so checking it again guards nothing.
- Change: ATTACHMENT_PATH, the two refusals and the ATTACHMENT_MAX_FILE_BYTES import leave writeFile. The path test and the size half of the file test in ChatTable.test go, along with the 'runner refuses any other path' docs sentence.

34. `packages/contracts/src/resources/RunnerVms.ts:53`: inventory VM `state` field (starting/running/stopped), which handles Admin telling a booting, serving or let-go VM apart (~18 lines).

- Why it can go: Only the settings badge reads it. T45's start-up sweep removes every listed vmId whatever its state, the proxy and file endpoints check only the entry's server, and `stopped` labelled the idle-released VMs that stayed listed, which the design removed; it now appears only during a remove or on the accepted failed-remove leftover.
- Change: RunnerVmState and the `state` field leave the contract, ChatTable's three-way state collapses to `server: ChatServer | null`, and RunnerSettings drops VM_STATES and the badge; inventory keeps `{vmId}` for the sweep.

35. `packages/contracts/src/resources/Runner.ts:22`: nullable agentName, 'agent gone' fallbacks and AgentGoneError, which handles A chat whose agent row no longer exists (~8 lines).

- Why it can go: Agents are never deleted: there is no DELETE FROM agents, and chats.agent_id is a foreign key with foreign_keys ON. agents.get and agents.list also return archived agents, so a chat's agent always resolves to a name.
- Change: agentName becomes a plain String in ChatSummary and RunnerStatus. The 'An agent no longer set up for chat' and AgentChatsPage `?? "An agent"` fallbacks go, and RunnerService's AgentGoneError class and check become an orDie lookup.

36. `packages/contracts/src/resources/Chats.ts:54`: stored chat_messages.state and chat_messages.type columns, which handles Marking a message lost or finding compactions without touching its JSON (~6 lines).

- Why it can go: HEAD~1 used them for `UPDATE ... SET state = 'lost'` and `type = 'compaction'` queries, both now removed. Today `type` is never read and `state` always equals isSettled(json), so readMessage can compute ChatMessage.state from the decoded message; the wire field stays for the web.
- Change: Both columns and their CHECK leave Schema.ts. ChatRepository loses MessageRow.type/state, their INSERT values, `type/state = excluded.*` and `OR chat_messages.state IS NOT excluded.state`. readMessage derives state itself.

37. `packages/contracts/src/resources/RunnerVms.ts:26` **boundary check**: skills record key-equals-name filter and property-name check, which handles T45 sending a skill under a key different from its name (~5 lines).

- Why it can go: T45 is the runner's only caller and builds the record keyed by `skill.name` (RunnerService attempt), so a mismatch would need the producer to contradict itself; SkillSnapshot.name is already a validated SkillName.
- Change: skills becomes Array(SkillSnapshot) and the runner writes `.opencode/skills/${skill.name}`, so both checks go.

38. `packages/contracts/src/models/Chat.ts:30`: `waiting` chat status alongside stored questions, which handles Showing an execution blocked on a question rather than working (~4 lines).

- Why it can go: Open questions are already stored and streamed (chat_questions and the `questions` event the web holds next to status), so `waiting` just means `running` with questions. Keeping it separate costs a status flip and a 'chat' publish (which reloads the chat list) on every forms read, markRunning's CASE, and an extra `|| waiting` in every owed or rerun check.
- Change: ChatStatus and the CHECK lose `waiting`. readForms stops setting status, markRunning becomes SET status='running', and the running/waiting pairs in RunnerService, ChatRepository and TaskService become `running`. ChatView checks questions.length for `working`.

39. `apps/server/src/tasks/TaskService.ts:153`: ended-hook guard on running/waiting statuses, which handles An execution reported as ended while still running or waiting (~1 lines).

- Why it can go: RunnerService.end is the hook's only caller and passes only 'failed', 'interrupted' or null. The hook's `Chat["status"]` type admits values that never arrive.
- Change: ChatHooks.ended takes `"failed" | "interrupted" | null` and the guard keeps only the interrupted check.

## Chats and persistence

40. `apps/server/src/persistence/Schema.ts:227`: chat_questions table plus setQuestions diff, which handles questions outliving their VM, e.g. across a server restart (~35 lines).

- Why it can go: Questions die with the VM and every VM dies with its execution (a start removes them all); the table was durable only for the restore notes that told the agent about lost questions, which e17e711 removed, so persisting them now only leaves stale, unanswerable questions after a crash (the integration test seeds exactly that with setQuestions).
- Change: The table, QuestionRow/QUESTION_COLUMNS/decodeQuestions/encodeForm, repository.questions and the 23-line setQuestions diff, and the question deletes in discardUncommitted and finishDelete go; readForms keeps the listed forms on the Execution (cleared when an attempt ends), and ChatService reads them through the runner for snapshots and answer validation.

41. `apps/server/src/chats/ChatIds.ts:19`: inputIdOf with isInputId tail validation, which handles a root user message with T45's prefix but no input tail (~8 lines).

- Why it can go: Only T45 prompts the root session of a sealed VM, always under inputMessageId, so every user message written to the root is an input; the tail validation guards against fabricated ids, and the function exists only to set inputsTaken, which just triggers an inputs re-read (pendingInputs already matches by inputMessageId).
- Change: inputIdOf, isInputId and the InputId/Schema imports go; saveMessages sets inputsTaken when it wrote a user message in the root session.

42. `apps/server/src/persistence/Schema.ts:208`: chat_messages.state column, which handles a message marked lost when its VM went away first (~5 lines).

- Why it can go: The 'lost' value went with e17e711; live/settled is isSettled(json), computed from the same JSON at write time, so the column duplicates the json, and the upsert's 'OR state IS NOT excluded.state' duplicates the json comparison (cut keeps time.completed and status, so deriving it on read is safe).
- Change: The column and its CHECK, MessageRow.state, the insert value, and the upsert's state SET and OR clause go; readMessage sets ChatMessage.state from isSettled on the decoded message, so the contract and web are unchanged.

43. `apps/server/src/chats/ChatRepository.ts:299`: hasPending recheck in TaskService.ended, which handles an input arriving as the execution ends, before the task settles (~4 lines).

- Why it can go: On the finish path, finish's own transaction already refuses to end while an input is unsent, and done/captureAll guarantee that sent inputs are stored, so the check is always false; on the failure path, discard runs before end and makes the execution's inputs pending again, so it is always true and that ended call never settles anything (contrary to sandboxed-chats.md, which says a refused VM fails a step's work).
- Change: hasPending and its check in TaskService.ended go; the failure path then either stops calling ended (gated on end's finished flag) or really settles the task as failed, a policy pick, but the recheck itself is dead either way.

44. `apps/server/src/persistence/Schema.ts:207`: chat_messages.type column, which handles queries filtering messages by type (compaction, user/assistant restore) (~4 lines).

- Why it can go: The only queries that filtered on type (type = 'compaction', type IN ('user','assistant')) were removed with compaction and restore notes in e17e711; nothing filters on it now, and MessageRow.type is selected but never read, since readMessage decodes json.
- Change: The column, its slot in MESSAGE_COLUMNS, the insert value, the upsert's 'type = excluded.type' and MessageRow.type go.

45. `apps/server/src/chats/ChatRepository.ts:302`: deletePending's second pendingInputs check, which handles an input taken between cancel's pending check and the delete (~4 lines).

- Why it can go: RunnerService.cancel already checked under the per-chat input lock that the input is pending and, if it was sent to the VM, withdrew it and confirmed that OpenCode hadn't delivered it; capture can't store a user message for an input OpenCode doesn't have, so the second read always agrees.
- Change: deletePending becomes a plain DELETE, and RunnerService.cancel returns true after it.

46. `apps/server/src/chats/ChatHooks.ts:14` **already gone in your tree**: ended hook typed with every chat status, which handles an execution ending running, waiting, or with an interrupted root (~3 lines).

- Why it can go: end only ever passes failed, interrupted or null, and interrupted only when finish reads a root outcome of 'interrupted'; that needs a session.interrupt call, which T45 never sends now that stop removes the VM, so TaskService.ended's running/waiting/interrupted early return is dead.
- Change: ended takes 'failed' | null, finish maps only outcome 'failed' (else null), and TaskService.ended's first guard goes.

47. `apps/server/src/chats/ChatService.ts:611`: markDeleted RETURNING plus early return in delete, which handles chat row gone between commandChat and markDeleted (~3 lines).

- Why it can go: delete runs in one transaction on SQLite's single connection after commandChat found the live chat, and markDeleted doesn't filter deleted_at, so it always updates exactly one row.
- Change: markDeleted returns void, and delete drops its if/return.

48. `apps/server/src/chats/ChatService.ts:170`: re-announce of a repeated, still-pending input, which handles a client retrying a send whose wake was lost (~2 lines).

- Why it can go: A lost wake is already covered by the first post's afterCommit wake, the re-wake when an execution ends while the chat is still owed, and the server-start rerun of owed chats; the repeat path never calls markRunning, so after failed/interrupted the woken attempt returns on its status check, and while one runs deliver skips the input through execution.sent. It does nothing. If a same-id retry is meant to restart a failed chat, it would need markRunning, which it lacks.
- Change: The pendingInputs read and the announce in the repeat branch go; a repeated identical input just returns.

49. `apps/server/src/chats/ChatRepository.ts:209`: ON CONFLICT DO NOTHING on chat insert and addInput, which handles concurrent insert of the same chat or input id (~2 lines).

- Why it can go: post checks get/exists and input(...) and computes the next ordinal inside its own transaction on SQLite's single connection, so neither insert can conflict; a conflict would be a bug, and silently dropping it hides that.
- Change: Both ON CONFLICT clauses (line 209 and line 296) go.

## OpenCode client, attachments, agents

50. `apps/server/src/opencode/OpenCode2Client.ts:30`: OpenCode2SilentStreamError class + timeoutOrElse failing the stream, which handles Event stream goes silent; distinguish that failure from a plain end (~12 lines).

- Why it can go: The only consumer (RunnerService.ts:420-447) treats a stream that ends and one that fails the same way, offering 'ended' and so raising StreamEndedError and a restart, so Stream.timeout(silence), which ends the stream on silence, already covers it. The only thing lost is the stream-level log line for silence; execute still logs the restart.
- Change: The 9-line error class, its member in the events error union, and the 4-line timeoutOrElse go; Stream.timeout(silence) replaces them, and the test asserts that the stream ends instead of naming the tag.

51. `apps/server/src/opencode/OpenCode2Client.ts:187`: Content-Length pre-check in capResponses, which handles OpenCode answer declares a Content-Length above 64 MiB (~12 lines).

- Why it can go: The streaming byte counter right below already fails any body over maxBytes while reading, with the same error. The header check only saves reading up to 64 MiB from a server honest enough to declare the size, and a hostile server just omits it.
- Change: The one-line content-length check goes, and so does the test 'refuses an answer that says it is too large before reading it', which exists only for it.

52. `apps/server/src/opencode/OpenCode2Client.ts:132`: events as Effect<Stream> (subscribe phase before the stream), which handles Event subscribe answers non-OK, non-502-504 status after a successful startChat (~6 lines).

- Why it can go: The wrapper's stated guarantee (succeeds once the server accepted the subscription) is false: docs/internals/chats.md:89 says the subscriber registers only just before the first frame, so RunnerService's server.connected Deferred is what makes 'subscribe before work' true. The only behavior the outer Effect adds is failing the chat instead of restarting on a 401/500 at subscribe. Nothing produces that after a successful startChat unless something breaks its contract: a bad runner token fails startChat first, and the proxy answers 503 or 502 (already 'lost') for a missing or silent VM.
- Change: events becomes a plain Stream (Stream.unwrap of readEvents with filterStatusOk inside), the nested type in OpenCode2Api collapses, and RunnerService.ts:420 loses one yield*.

53. `apps/server/src/runner/RunnerService.ts:474`: Re-sorting stored sessions with sessionsUnder before import, which handles Stored sessions out of parent-before-child order, or not under root (~6 lines).

- Why it can go: repository.sessions already returns rows ORDER BY rowid (ChatRepository.ts:311). readTree inserts them as root followed by sessionsUnder order (parent first, only root's tree), discard deletes only uncommitted rows, and the upsert keeps rowids, so stored rows are already root-first, parent-first and only the tree.
- Change: The .map adding id/parentID for sessionsUnder and the `[...filter(root), ...sessionsUnder(...)]` list go; import iterates `yield* repository.sessions(chatId)` directly.

54. `apps/server/src/runner/RunnerService.ts:327`: putFile catches PlatformError (attachment bytes missing on server), which handles A file bound to the chat has no bytes on disk (~6 lines).

- Why it can go: AttachmentRepository never removes the bytes of a bound attachment. upload writes bytes before the row, release and sweep delete rows (unbound or unheld only) before bytes, and detach deletes only unheld rows. Missing bytes need removal from outside T45.
- Change: The PlatformError branch and its log go, along with the doc clause 'one the server ... can't take is skipped'; the RunnerRefusedError catch stays.

55. `apps/server/src/attachments/AttachmentRepository.ts:58`: attachmentPath / files.path return null for non-AttachmentId ids, which handles An attachment id from the input payload or database isn't uuid.ext (~5 lines).

- Why it can go: Every caller except the download URL passes an id that is already schema-checked. Those are ChatAttachment.id decoded as AttachmentId (inputs, answers) and DB ids that upload generated (removeBytes, boundTo), so the null branches can't trigger. Only http.ts needs to validate an untrusted id.
- Change: The null branches go in removeBytes, putFile (`if (source === null) return`), and PromptService formatAnswers and appendAttachmentPaths. attachmentPath returns string, and http.ts checks isAttachmentId itself.

56. `apps/server/src/opencode/OpenCode2Client.ts:62`: modelRef returns undefined for unparseable slug; conditional model spread, which handles An agent's model slug isn't a parseable provider/model reference (~4 lines).

- Why it can go: Agents.handlers' requireOfferedModel admits only slugs the runner's ModelCatalog lists, `opencode-go/<non-empty id>`, on create and on every model change. AgentRepository.save is the only write to agents. Agent.model is already a TrimmedNonEmptyString, so Model.Ref.parse can't fail and the trim is a no-op.
- Change: modelRef becomes Model.Ref.parse(model) (no liftThrowable/Option/trim, shorter doc), and RunnerService.ts:470 drops the `model === undefined ? {} : { model }` spread.

57. `apps/server/src/runner/RunnerService.ts:448`: CONNECT_TIMEOUT on awaiting server.connected, which handles Stream sends heartbeats for a minute but never server.connected (~3 lines).

- Why it can go: A silent stream is already failed by OpenCode2Client's SilentStreamTimeout (45s, below this 60s), which fails the connected Deferred, and an ended stream fails it at once. What's left is OpenCode streaming heartbeat bytes while never sending server.connected, its own first frame by protocol, which is a contract break with no evidence it happens. A request whose headers never arrive isn't covered today either, since the timeout wraps only the Deferred.
- Change: The CONNECT_TIMEOUT constant and the timeoutOrElse wrapper go; it becomes `yield* Deferred.await(connected)` (and the 'within a minute' clause in chats.md).

58. `apps/server/src/opencode/OpenCode2Client.ts:251`: readFile maps timeout to null; caller also maps every failure to null, which handles A file read from the VM takes over 60 seconds (~2 lines).

- Why it can go: The only caller (RunnerService.ts:499) already wraps readFile in orElseSucceed(() => null), so a plain Effect.timeout failure lands on the same null. Two layers turn failure into null.
- Change: timeoutOption plus Option.getOrNull become Effect.timeout, and the `| null` leaves OpenCode2Api.readFile's success type (or the orElse moves into readFile and the RunnerService wrapper goes).

59. `apps/server/src/attachments/http.ts:110`: catchReason PlatformError NotFound -> 404 when serving bytes, which handles Attachment row exists but its file is missing on disk (~1 lines).

- Why it can go: No code path leaves a row without bytes. upload renames bytes into place before INSERT, and sweep and release delete the row before removing bytes. A file removed from outside T45 still gets the existing PlatformError catch's logged 500.
- Change: The single NotFound catchReason line goes.

## Fakes and tests

60. `apps/runner/src/ChatTable.test.ts:130` **harness-flagged** **security**: ATTACHMENT_PATH regex and size check in ChatTable.writeFile, which handles T45 sends an oversized file or a path outside attachments/ (~38 lines).

- Why it can go: T45's only putChatFile caller sends `attachments/<AttachmentId>`, whose schema already has the same uuid.ext pattern, and uploads already enforce ATTACHMENT_MAX_FILE_BYTES; the runner re-checks T45's own contract against T45, and the agent in the VM can rewrite those files anyway.
- Change: ATTACHMENT_PATH, the two refusals and the import in ChatTable.ts go, along with the size assertions and the whole 'A file goes nowhere but...' test.

61. `apps/server/src/runner/RunnerService.integration.test.ts:267`: cancel's message.get check after inbox.cancel, which handles cancel lands after OpenCode delivered the input, before T45 captured it (~20 lines).

- Why it can go: This needs a cancel inside the roughly 150 ms batch window between OpenCode's delivery and T45's capture; the design says cancel works on pending inputs (user message not stored), which this input still is, so without the check it would simply be withdrawn.
- Change: The message.get/taken branch in RunnerService.cancel goes, along with the input-3 half of the cancel test (hold release, already_taken assert, inputs assert).

62. `apps/runner/src/ChatTable.test.ts:159`: ChatTable.runningEntry guard on file/workspace ops, which handles write/pack/unpack for a chat whose VM isn't running (~18 lines).

- Why it can go: MicrosandboxChats' write/pack/unpack already fail through `held` when the VM isn't in `started`, which ChatTable turns into a RunnerRefusedError, and T45 handles every RunnerRefusedError there the same way (log and skip), so the table-level check duplicates it; only the fake lacks the check, and these asserts test that.
- Change: runningEntry and its three calls in ChatTable.ts go, along with the 'The chat isn't running.' asserts for writeFile/readWorkspace/writeWorkspace.

63. `apps/runner/src/http.test.ts:146` **boundary check**: routerConfig maxParamLength 512 plus 150-char VM id test, which handles a VM id longer than the router's 100-char param limit (~16 lines).

- Why it can go: T45's vmIds are always ChatIds (36-char UUIDs per the ChatId schema), and inventory ids are the same chat ids; the proxy's wildcard has no length limit in effect's FindMyWay, so only the made-up long :vmId needs the raised limit.
- Change: RunnerHttp.routerConfig, its use in runner server.ts and in http.test's toWebHandler, and the 150-character test go.

64. `apps/server/src/runner/FakeOpenCode.testkit.ts:63`: files map and /api/fs/read route, which handles T45 reads a file from the VM's /work via OpenCode (~13 lines).

- Why it can go: No test puts anything in openCode.files and no test reaches hooks.saved's read (only WorkflowService step receipts call it, and no workflow test uses this fixture), so the route and its wipe are fake behaviour no test uses.
- Change: The files field, its initializer, the fs/read route and the files loop in wipe go; any fs read would then throw as unscripted.

65. `apps/server/src/runner/RunnerService.integration.test.ts:314`: test injects stored questions after the VM is gone, which handles answer to a stored question while no execution runs (~12 lines).

- Why it can go: The design never leaves questions without an execution: discardUncommitted deletes them on stop/failure/each attempt start, and finish happens only when OpenCode is idle with no form pending. Answers reach the VM only through withVm on the running execution, so no answer can start a VM.
- Change: The setQuestions injection, the question_gone assert and the runner.starts assert at the end of the question test go.

66. `apps/server/src/chats/ChatService.test.ts:253`: cleanup_pending flag and pendingDeletes retry at start, which handles delete's cleanup fails because the runner is down (~12 lines).

- Why it can go: Before e17e711 cleanup removed the VM through the runner, so 'runner down' made it fail and the next start retried; cleanup now only interrupts the execution and deletes local files and rows, so the runner can't make it fail. The only case left is the server stopping mid-cleanup, which leaves orphan files and rows of an already-deleted chat.
- Change: The cleanup_pending column, pendingDeletes, the flag update in finishDelete, the start loop in ChatService.start, and the 'runner down' plus next-start part of this test go.

67. `apps/server/src/runner/FakeRunner.testkit.ts:12`: models knob and /models fake route, which handles T45 lists the models the runner offers (~7 lines).

- Why it can go: Only Agents.handlers calls RunnerService.models, and no test exercises it through this fixture; no test reads or sets runner.models, so this is fake behaviour no test uses.
- Change: The models field, its initializer, the /models branch of the operation switch and its case go.

68. `apps/server/src/runner/FakeOpenCode.testkit.ts:101`: subagent sessionId addressing in chatSession/ask/answerText, which handles agent asks or writes inside a subagent's session (~6 lines).

- Why it can go: Every caller of ask and answerText passes only (openCode, chatId[, text]); nothing in the tests uses the sessionId param or option, so the subagent lookup branch is fake behaviour no test uses.
- Change: chatSession takes just chatId and reads fake.sessions; the sessionId param of ask and the sessionId option of answerText, plus their doc wording, go.

69. `apps/runner/src/http.test.ts:136`: health.reason ?? fallback reason in startChat, which handles sandbox health unavailable with a null reason (~5 lines).

- Why it can go: MicrosandboxChats.health returns either {true, null} or {false, a KVM reason}; no implementation produces {isAvailable: false, reason: null}, which only the fake sets.
- Change: The second half of the KVM test (null-reason refusal) goes; the fallback string can go once health's type ties a reason to unavailability.

70. `apps/server/src/runner/FakeOpenCode.testkit.ts:579`: DELETE form route (form.cancelled), which handles a member dismisses an agent's question in the running VM (~4 lines).

- Why it can go: No test dismisses a question through a VM: Chats.handlers.test only checks dismiss is refused NotFound before any VM, and no integration test calls chats.dismiss, so this is fake behaviour no test uses.
- Change: The DELETE alternative in the form-route condition and the form.cancelled else-branch go; the route only handles POST reply.

71. `apps/server/src/runner/FakeRunner.testkit.ts:125`: refusal of files/workspace for a chat with no VM, which handles T45 puts a file or reads /work of a chat without a VM (~4 lines).

- Why it can go: T45 calls putChatFile/put/getChatWorkspace only inside a running attempt, and stop interrupts the attempt before its VM goes, so no test reaches this branch; this is fake behaviour no test uses.
- Change: The part-without-VM refusal and its comment go.

72. `apps/server/src/chats/Chats.testkit.ts:91`: layerStore with ServerActivation = Effect.never, which handles parking background chat execution in tests (~3 lines).

- Why it can go: Since e17e711 RunnerService no longer uses forkParked; only AutomationService reads ServerActivation, which is not in this layer, and Layer.provide doesn't pass ServerActivation on to the layers built on top, so layerStore behaves exactly like layer and parks nothing, despite what its doc says.
- Change: layerStore and the ServerActivation import go; its users (ChatService.test, Chats.handlers.test, webhook.test, AutomationService.test) use layer.

## Found through the docs

73. `apps/runner/src/MicrosandboxChats.ts:432` **unverified**: runner start-up sweep plus runner labels, which handles runner restarted, leaving its stopped VMs' disks behind (~40 lines).

- Why it can go: With every VM destroyed when its execution ends, microsandbox's builder .ephemeral(true) ('removed by the host runtime after the VM reaches a terminal status') covers VMs that stop with the runner. This is unverified: someone needs to check on a real microsandbox that ephemeral VMs are removed after their runner process dies. The sandboxed-chats.md reason 'so a VM always starts with a password this runner knows' is already stale, because VMs are never resumed.
- Change: sweep in ChatSandbox and MicrosandboxChats, layerHousekeeping in server.ts, LABEL, RUNNER_PORT_LABEL and runnerLabels, and the fake's sweep go, and .ephemeral(true) comes in; sandboxName's port hash stays.

74. `apps/runner/src/ChatTable.ts:154` **harness-flagged** **security**: ATTACHMENT_PATH regex check on putChatFile paths, which handles T45 sends a file path outside attachments/ (~24 lines).

- Why it can go: T45 always builds the path as attachments/<AttachmentId>, and anyone holding the runner token can already write any file in the VM through startChat's agent files or the OpenCode proxy, so the check protects nothing.
- Change: The regex, its refusal and the 'A file goes nowhere but a stored attachment's name' test go; alternatively the endpoint takes the attachment id and the runner builds the path. The sandboxed-chats.md clause 'the runner refuses any other path' goes too.

75. `apps/runner/src/ChatTable.ts:24`: per-VM state starting/running/stopped in table and inventory, which handles admin sees VMs the runner let go but kept listed (~18 lines).

- Why it can go: Old tables kept stopped entries for slept VMs; now remove deletes the entry, so 'stopped' only labels a failed start (which T45's finalizer removes) or a failed removal (listed either way, and maybe still running), and 'running' is already server !== null.
- Change: RunnerVmState, the state field and its assignments, and the VM_STATES badge in RunnerSettings go; the stale 'No chat has run since the runner started' and RunnerStatus's 'VMs the runner has seen since it started' text go with them.

76. `apps/runner/src/ChatTable.ts:135`: release() on a failed start (runner removes the VM itself), which handles VM booted halfway, then its start failed (~12 lines).

- Why it can go: RunnerService registers its removeChat finalizer before calling startChat, so T45 always removes a VM whose start failed or timed out, and the lock makes that removal wait for the start; the runner's own removal duplicates this and goes against 'only T45 removes VMs'.
- Change: The release helper and the tapError on start go; the failed-start test then calls remove like T45 does.

77. `apps/server/src/runner/RunnerService.ts:619`: SessionNotFoundError catches for sessions removed in the VM, which handles agent or plugin deletes its own subagent session via OpenCode's API (~11 lines).

- Why it can go: The only cause the chats.md trap gives is an agent or plugin calling session DELETE with the server's password, which is adversarial and made up; a removed root already fails the execution, and a removed subagent could fail it the same way.
- Change: The captureSession catch that splits root and subagent and calls known.delete goes, as do the SessionNotFoundError catches in readForms and in done's inbox loop; the 'A session can be removed from inside the VM' trap and the 'root session removed inside the VM' wording in chats.md go too, and ChatService answer/dismiss SessionNotFoundError→question_gone can fall through to 'unavailable'.

78. `apps/server/src/tasks/TaskService.ts:157`: hasPending recheck in the ended hook, which handles execution ends while the task still has an unsent input (~4 lines).

- Why it can go: finish already refuses to end while any pending input is unsent, in the same transaction ended runs in, so on that path hasPending is always false; on the failure path discard runs first and makes the triggering input pending again, so it is always true and a step whose execution fails (refused VM, gone agent) never settles, contrary to sandboxed-chats.md ('fails the chat, and with it a step's agent work').
- Change: The hasPending condition in ended and ChatRepository.hasPending go, along with the chats.md sentence 'Settlement rechecks pending inputs in its transaction…'.

79. `docs/planning/cleanup.md:16`: stale planning entries for removed boot/recovery machinery, which handles T45 dies between restore and setBoot, or between capture and saved (~3 lines).

- Why it can go: setBoot and recoverTask no longer exist, and a restart now discards uncommitted output and re-runs the execution, so neither the double restore nor the 'replay stored messages' fix applies; line 19's 'the chat's worker keeps retrying' is wrong too, since an over-cap answer is a DecodeError and fails the execution once.
- Change: Lines 16 and 17 are deleted and line 19 is rewritten.

80. `apps/server/src/runner/RunnerService.ts:656`: done's unsent-pending-input check, which handles input posted between deliver and the idle check (~2 lines).

- Why it can go: finish rechecks unsent pending inputs inside its transaction and returns false so the loop delivers them, which already covers this case; the post also sends a wake.
- Change: The two-line pending check at the top of done goes.

81. `apps/server/src/runner/RunnerService.ts:499`: readFile orElseSucceed(null) swallowing VM errors, which handles VM went away before the hook read an attach snapshot (~1 lines).

- Why it can go: A gone VM already restarts the execution and discards the call, so turning the failure into 'unread' only commits a stray step_attach refusal input (via tasks.continue) that the next execution sends for a call it never made.
- Change: orElseSucceed goes (null stays for read timeouts), and so does the sandboxed-chats.md clause 'as when the VM went away first'.

## Contested (a skeptic found a reason to keep it)

82. `apps/server/src/runner/RunnerService.ts:537`: readTree filter via OpenCode2Client.sessionsUnder (also import ordering at 482), which handles VM holds OpenCode sessions that don't descend from the chat's root.

- Keep, per the dependents skeptic: The filter itself only covers a made-up case, but sessionsUnder can't go: it is also the parents-first sort that session import needs. OpenCode 2.1.4 lists sessions by time_updated, not creation, so with the readTree filter gone, rowid order is not parents-first. The only safe change is dropping the readTree filter alone, which saves about 3 lines, not about 30.

83. `apps/runner/src/ChatTable.ts:115`: inventory vms list with starting/running/stopped states, which handles admin sees which chats hold a VM on the runner and its state.

- Keep, per the dependents skeptic: Refuted as stated: the server-start sweep reads inventory.vms to remove leftover VMs. That sweep is part of the landed design and is documented with a real reason (failed removes, a crashed T45 or a database wipe leave VMs that nothing else removes while the runner stays up), so inventory.vms has to stay as a list of VM ids. The rest of the proposal still goes, at about the same ~85 lines: the state field and RunnerVmState, RunnerStatus.vms with the chat and agent lookups, the page's Chats section, and ChatTable's state field (server !== null already means running at :96 and :147).

84. `apps/server/src/opencode/OpenCode2Client.ts:111`: seen set in sessionsUnder (parent-cycle guard), which handles Root session's parentID points into its own subtree, forming a cycle.

- Keep, per the dependents skeptic: The guard is needed for a different, real reason: `readTree` feeds `sessionsUnder` the session list from the VM's OpenCode, which the codebase already treats as agent-controlled, and without `seen` a crafted list makes the synchronous BFS run forever. The ~3-line estimate is correct.

85. `apps/server/src/tasks/TaskService.ts:153`: ended hook branch for running/waiting status, which handles execution ends while chat still running or waiting.

- Keep, per the scenario skeptic: The claim is wrong. Besides `end` (which passes only failed, interrupted or null), `ended` has a second caller: the startup recovery loop, which passes each active task chat's stored status, and that status is running or waiting for every chat a restart caught mid-execution, so dropping the guard would fail those tasks on every restart.
- Keep, per the dependents skeptic: The claim is false. The runtime results path does only pass failed, interrupted or null, but the crash-recovery loop at server start calls `ended` with the chat's stored status, which can be running or waiting. Without the guard, that loop would settle a running chat's active task as failed.

One skeptic started a test VM on this machine with `msb run alpine` and removed it afterwards (`msb-b7811688`).
