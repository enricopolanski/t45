# Chats

OpenCode runs a chat; T45 keeps it. T45 asks the runner for executions and keeps what they return ([`ChatExecutions.ts`](../../apps/server/src/chats/ChatExecutions.ts)); the runner decides how an execution happens ([`ExecutionOrchestrator.ts`](../../apps/runner/src/ExecutionOrchestrator.ts)). The contract between them is [`Runner.ts`](../../packages/contracts/src/resources/Runner.ts); the VM boundary and workflow tool receipts are in [sandboxed chats](./sandboxed-chats.md).

## What T45 keeps

T45 keeps three things per chat: its inputs, the conversation its executions wrote (OpenCode's sessions and messages), and the VM disk the last finished execution left, a gzipped tarball in the server's state folder (`chat-disks/<chat>.tgz`). The disk holds everything the agent changed, OpenCode's own database included, so the agent remembers the conversation from its disk, and T45's copy is what members read. The VM keeps nothing: every execution starts a new one and removes it when it ends, and its processes and questions go with it. Stored sessions and messages are OpenCode's wire JSON, decoded with the pinned `@opencode` schemas, so bumping the pin means every stored row must still decode, and every saved disk's OpenCode database must open through OpenCode's own migrations. Reads cut long strings to 8,000 characters and drop inline file `data`; only `chats.getMessage` sends a message whole.

An execution stores what OpenCode writes as it goes, so members watch it live, and commits it in the transaction that records how the execution ended. An execution that doesn't finish has what it wrote discarded, its questions with it, and `replaced` sends open streams a fresh snapshot; the conversation only ever holds what finished executions wrote. A `failed` chat is therefore one of two things: a finished execution whose root turn failed, its output committed, or an execution that failed itself, its output discarded.

## Every execution restores the same way

T45 drops uncommitted output and asks the runner to `execute` the chat with everything it starts from: the agent's current setup, the root session's id and the chat's title, whether somebody can answer questions, the saved disk, and the pending inputs with their files. The runner starts a new VM on that disk, or on a new one for a chat's first execution, writes the agent's setup and the files, creates the root unless the disk has it, switches it to the agent's current model, sends the inputs, streams back what OpenCode writes, and once OpenCode is done removes the VM and sends its disk. A first message, a follow-up and recovery after a server restart all take this one path, so restore can't quietly break. The root gets the question rules and the title when it is created, and its subagents' sessions copy the rules; agent and model changes reach a chat at its next execution. A disk whose OpenCode won't serve fails the execution, and every later one the same way, since the saved disk doesn't change.

## One execution per chat

A chat owed an execution has one owner in `ChatExecutions`' memory, which runs its executions one at a time while the chat's `status` is `running`. A post starts the owner unless the chat has one, and otherwise `send`s the posted input to the running execution, which ignores an input id it already has. An execution lasts as long as its `execute` call: the runner removes its VM when the execution finishes or fails, and when the call ends, as when T45 stops it or goes away. The owner checks the status and gives up the chat in one transaction, so a post commits either before, and the owner runs again, or after, and starts a new owner.

A post signals the execution after it commits: [`ChatService.post`](../../apps/server/src/chats/ChatService.ts) publishes `posted` and delivers the input through `SqlClient.afterCommit`, which runs once the outermost transaction commits, is dropped with a savepoint that rolls back, and runs at once outside a transaction. The post writes `running` in the same transaction, so a signal lost to a crash is not lost work. `ChatService` construction schedules recovery for every chat still `running`. Recovery waits for server activation so the execution consumer is running before chats resume; there is no separate service start call.

## Inputs, pending and cancel

An input is saved, its files bound to the chat, before the send is answered. Its payload is stored as JSON from one encoder, and the same input id again is a no-op when its payload encodes the same and an `input_conflict` otherwise: OpenCode admits a repeated id with any payload and keeps the first, so T45 compares. The comparison comes before any other check, so a retry of a saved input stays a no-op. Inputs go with `delivery: "queue"`, so one that arrives during a turn waits for it to end instead of steering it.

An input is pending while no user message is stored under its id, and an execution sends only the pending ones: a taken input is in the saved disk's conversation, and sending it again would append an empty turn. Pending needs no state of its own: discarding an execution's output is what makes the inputs it took pending again. An input counts as taken even when its turn then fails, since a waking session delivers its inbox before it resolves the model.

A cancel works only on a pending input. T45 asks the runner to withdraw it, which takes it back from OpenCode's inbox if it was sent there and keeps the id so a later `send` can't bring it back; then the row is deleted. A cancel in the moment between OpenCode delivering an input and the runner reading it, or between T45 reading the pending inputs for an `execute` call and the runner receiving it, still succeeds, and the agent answers the input anyway. The deleted row is all that keeps the input out of later executions, since OpenCode keeps no tombstone. Cancel and delivery share the execution's lock on the runner, so an input is never cancelled mid-prompt.

## An execution that doesn't finish is discarded

An execution gets one VM and is never retried automatically. A failed execution discards its uncommitted output and questions, leaves the last finished disk intact, and makes the chat `failed`; ending the runner call triggers VM cleanup. This includes a lost VM, an event stream that ends or goes silent before completion, and a runner transport or protocol failure. The next input posted to the chat starts another execution with its pending inputs; a server start does not restart a failed chat.

Starting over would replay work from the last finished disk, with no checkpoint of the failed execution and no rollback of workflow or external tool effects. Nothing reconnects to a running VM: a broken stream may have missed events and `opencode serve` replays none. Startup waits for OpenCode and MCP readiness remain bounded; they happen before inputs are delivered. The runner sends a heartbeat every 15 seconds, since fetch ends a response that stays silent for 5 minutes, as an execution does while the agent waits.

A stop records `interrupted` and asks the owner to end the execution's `execute` call, so the runner removes its VM; the owner discards the output and runs again only for an input posted since. It cancels nothing: the inputs the execution had taken are pending again beside those still queued, and they run with the next input posted.

## When an execution is done

OpenCode says when it is done, by its own state: every input the runner has sent, no session active, no shell running, every known session's inbox empty, and every background subagent reported. The events naming OpenCode's last writes can arrive after it reports done, so the runner then reads every session again and checks once more. It then removes the VM, which flushes its disk, and sends `finished` with the root session's outcome and the disk. T45 saves the disk, then commits the output in one transaction; when no input is pending it records the outcome as the chat's status (`failed` or none) and runs `ended`, and otherwise the chat stays `running` and a new execution runs the inputs that came in too late for this one. A stop that recorded `interrupted` first wins, and the execution commits nothing.

Background subagents are the trap. A completed `subagent` tool call whose metadata says `status: running` started background work, including a call OpenCode moved to the background. Once that child ends, nothing is active until its report reaches the parent as a synthetic message with `metadata.source: "subagent"` and its `childID`, so idleness alone would remove the VM before the report. The agent can continue the same child in the background again, so launches and reports are counted per child, by tool call and by message. The tracking is the execution's own memory on the runner, built from what it read; the saved conversation owes it nothing, since an execution finishes only once every background subagent reported.

The execution relies on an open question keeping its session active, so a waiting chat keeps its VM until the question is answered or dismissed, or the chat is stopped; nothing times it out. Open questions are kept only in the server's memory, since they go with the VM. Answers and dismissals go through the runner to the running execution's VM, and with none, or with its VM lost, the question is gone. They are not inputs, so an execution that doesn't finish loses them: the next one sends its inputs again, and the agent may ask again.

## The disk

Only a finished execution saves its disk ([sandboxed chats](./sandboxed-chats.md#chats)); what a discarded execution changed goes with its VM. T45 writes it beside the last one and renames it in, so a save cut short keeps the last good one. A refused restore or save fails the execution; its conversation cannot commit without its disk. T45 sets no limit on it, by decision: the disk's size, fixed when the runner makes it (`LIMITS`), bounds the tarball, which is held whole in the runner's and the server's memory on its way, in one RPC frame. A deleted file's blocks keep their bytes, so a saved disk doesn't shrink when the agent deletes.

The save is not part of the commit: it lands before it, so a crash or shutdown between the two leaves a disk whose OpenCode holds turns T45 discarded. Their inputs count as pending and go again, OpenCode answers each with the message it has and an empty turn, and the next execution reads the discarded turns back.

## Ids

A chat's id and agent never change. Its single origin is either a member-owned Conversation or a triggered Task, stored in `chat_origins` and created atomically with the chat and first input. Task identity is chat identity; a retry after a final outcome gets a new pair. The origin remains with the chat tombstone. Chat storage and execution events carry neither member ownership nor workflow references.

The root session is `ses_t45_<chat>` and an input's message `msg_t45_<chat>_<input>`, so every execution names them the same and an input's stored user message tells it is taken. Subagent sessions and the agent's messages take OpenCode's ids, which the disk keeps; what an execution writes again after a discard gets new ones. Every native row is also keyed by chat, since one VM must never write into another chat's copy. T45 assigns session-local ordinals as it saves messages, because its ids do not sort with OpenCode's.

## Executions and tasks

TaskService gives ChatService its consumer, using WorkflowService's receipt functions; executions wait for it before they start. The consumer runs on the execution's fiber, so a stop interrupts receipt handling and chat and task completion share a transaction. The files the step tools leave for T45 arrive in the stream before the messages naming them, so receipts never read from a VM. A task settling during execution uses ChatService's `requestStop`, which records `interrupted` in the caller's transaction and asks the owner to stop after commit; nothing waits for it, so the execution can stop itself.

TaskService starts, continues, stops and settles tasks. A stop leaves a task active, and step submission is provisional until approval; rejection continues the same task and chat. Execution checks pending inputs before committing completion; task handling trusts that result. The call ledger and workflow effects commit together.

Discarded and re-sent inputs repeat workflow side effects. The result consumer applies step calls as T45 saves them, before the execution commits, and the ledger keys them by native message and part ids; the execution that sends an input again writes new ones, so a step call the agent makes again is applied again, and discarding the output undoes nothing that committed. This gap is deliberate for now and recorded in `todo.md`.

## Streams

The runner holds the VM's `/api/event` stream as the execution's only upstream. The stream only marks what to read again and forwards text and reasoning deltas, so it never falls behind; the runner then pages each marked session and sends what it read, which T45 upserts by id. Deltas are never stored: the browser appends one to the part its ordinal names among the message's parts of that kind, and a new copy of a live message keeps text streamed past it, since OpenCode fills a part only when it ends.

The `ChatService` layer provides one `ChatEvents` bus shared by posts, executions and member streams; a second bus is a list or an open chat that stops updating. A stream subscribes before it reads its snapshot, and holds at most 1,000 changes it hasn't sent, since a client that stops reading keeps its request open; past that it drops them and sends a fresh snapshot.

## Delete

Deleting tombstones the chat. After commit its execution is stopped, and the chat's hold on its files, the files nothing else holds, its disk and its rows are removed; a cleanup cut short is finished at the next server start. The tombstone retains its origin and final Task outcome, so access and identity remain resolvable, and normal reads exclude it.

A chat exists from its first input on: a member's new chat is a page the web keeps until its first send carries the agent, so an empty chat leaves nothing behind.

## Locks and waits

Nothing inside a transaction waits on an execution or the runner. SQLite has one connection, so a transaction that waits on work needing SQL stalls every request. Public execution commands (answer, dismiss, cancel) call the runner outside transactions. Task handling reads and stores attachment snapshots before opening the transaction that records calls and applies workflow effects.

## OpenCode traps

Checked against the v2.1.4 source; check them again when bumping the pin.

- **Admission is by caller id, not content.** The same message id with other text or metadata is accepted and the first payload kept. Message ids are a global primary key: the same id in another session, or as a synthetic, is a `ConflictError`.
- **Inbox cancel leaves no tombstone.** It deletes the entry and answers 204 even when nothing was there, and the same id is admitted again afterwards with new content.
- **Creating a session with an id OpenCode has returns the stored one unchanged**, its title, model and rules included. `switchModel` adds a message only when the model changes.
- **A re-sent input id OpenCode has returns that message**, and with the default `resume` it also appends an empty idle turn.
- **A session can be removed from inside the VM**, by an agent or plugin with the server's password. Removing one interrupts it, removes its children too, and publishes `session.deleted` for each. A missing session creates nothing: a prompt, `message.list`, `inbox.list` or `session.get` on it is `SessionNotFoundError`. A removed subagent keeps what the runner read of it; a removed root fails the chat, since it isn't a lost connection.
- **`/api/event` registers its subscriber just before the first frame, `server.connected`.** Events between the HTTP 200 and that frame are missed, so start work only after it. A subscriber more than 4,096 frames behind is failed.
- **`opencode serve` outside a VM** needs its own HOME, XDG dirs and TMPDIR, or it writes into the shared `/tmp/opencode`. Without a key its built-in provider serves free models from opencode.ai, which a session without a model falls back to, and the server fetches its model catalog from models.opencode.ai at start and every five minutes; `OPENCODE_DISABLE_FREE_MODELS=1` and `OPENCODE_DISABLE_MODELS_FETCH=1` turn both off. A session whose pinned model is unavailable fails its turn instead of falling back. In a VM the network only reaches opencode.ai with T45's key, so this matters only for tests.

## Tests

Chat tests run the real services over test SQLite against a scripted runner ([`FakeRunner.testkit.ts`](../../apps/server/src/runner/FakeRunner.testkit.ts)) and wait on the chat's change feed.
