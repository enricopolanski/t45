# Chats

OpenCode runs a chat; T45 keeps it. The code is in [`apps/server/src/chats`](../../apps/server/src/chats) and [`RunnerService.ts`](../../apps/server/src/runner/RunnerService.ts), the VM boundary and workflow tool receipts in [sandboxed chats](./sandboxed-chats.md).

## What T45 keeps

T45 keeps three things per chat: its inputs, the conversation its executions wrote (OpenCode's sessions and messages), and `/work` as of the last finished execution, a gzipped tarball in the server's state folder (`chat-workspaces/<chat>.tar.gz`). The VM keeps nothing: every execution starts a new one and removes it when it ends, and its processes and questions go with it. Stored sessions and messages are OpenCode's wire JSON, decoded with the pinned `@opencode` schemas and never cut, since import needs them whole, so bumping the pin means every stored row must still decode and import. Reads cut long strings to 8,000 characters and drop inline file `data`; only `chats.getMessage` sends a message whole.

An execution stores what OpenCode writes as it goes, so members watch it live, and commits it in the transaction that records how the execution ended. An execution that doesn't finish has what it wrote discarded, its questions with it, and `replaced` sends open streams a fresh snapshot; the conversation only ever holds what finished executions wrote. A `failed` chat is therefore one of two things: a finished execution whose root turn failed, its output committed, or an execution that failed itself, its output discarded.

## Every execution restores the same way

An execution drops uncommitted output, starts a new VM from the agent's current setup (`startChat`), puts back `/work` and every file sent to the chat, and imports the committed conversation through OpenCode's session import, the root first and then the sessions under it, parents before their children; it creates the root when none is stored. It then sends the pending inputs with their files, captures what OpenCode writes, and once OpenCode is done saves `/work`, commits and removes the VM. A first message, a follow-up, a server restart and a lost VM all take this one path, so restore can't quietly break. Every imported session carries the current question rules, and the root the chat's current title and the agent's current model, so agent, model and title changes reach a chat at its next execution. An import OpenCode refuses fails the execution, and every later one the same way, since the committed conversation doesn't change.

## One execution per chat

`RunnerService` keeps the running executions in memory, at most one per chat, and runs one only while the chat's `status` is `running` or `waiting`. A wake starts an execution unless one runs, and a running one sends the inputs posted since to its own VM; one that would finish first sends them and goes on. The VM belongs to its execution alone: the execution starts it and removes it however it ends. An execution that ends wakes a new one while the chat is still owed one, as for an input saved as it ended.

A post wakes the chat after it commits: [`ChatService.post`](../../apps/server/src/chats/ChatService.ts) publishes `posted` and wakes the runner through `SqlClient.afterCommit`, which runs once the outermost transaction commits, is dropped with a savepoint that rolls back, and runs at once outside a transaction. The post writes `running` in the same transaction, and a server start wakes every chat still `running` or `waiting`, so a wake lost to a crash is not lost work. No execution starts a VM before `RunnerService.start`, which first removes every VM the runner lists.

## Inputs, pending and cancel

An input is saved, its files bound to the chat, before the send is answered. Its payload is stored as JSON from one encoder, and the same input id again is a no-op when its payload encodes the same and an `input_conflict` otherwise: OpenCode admits a repeated id with any payload and keeps the first, so T45 compares. The comparison comes before any other check, so a retry of a saved input stays a no-op. Inputs go with `delivery: "queue"`, so one that arrives during a turn waits for it to end instead of steering it.

An input is pending while no user message is stored under its id, and an execution sends only the pending ones: a taken input is in the conversation it imports, and sending it again would append an empty turn. Pending needs no state of its own: discarding an execution's output is what makes the inputs it took pending again. An input counts as taken even when its turn then fails, since a waking session delivers its inbox before it resolves the model.

A cancel works only on a pending input. If the running execution sent it, the cancel first withdraws it from OpenCode's inbox and looks it up, and is `already_taken` if OpenCode had delivered it; otherwise the row is deleted. The deleted row is all that keeps the input from coming back, since OpenCode keeps no tombstone. Cancel and delivery share a per-chat lock, so an input is never cancelled mid-prompt.

## An execution that doesn't finish is discarded

When the VM is out of reach, the attempt is thrown away: its VM is removed, its output discarded, and a new attempt starts in a new VM and sends its inputs again. Out of reach means the runner didn't answer, the event stream ended or sent no `server.connected` within a minute, or a request found no connection or a 502 to 504 from the runner's proxy; OpenCode's client wraps such a failure in a `ClientError`, so the check looks at its cause. Nothing reconnects to a running VM or keeps partial output: a broken stream may have missed events and `opencode serve` replays none. An attempt lost after it imported the conversation is replaced at once; attempts that keep failing before that wait 1, 2, 4 and up to 30 seconds. The chat stays `running` throughout, so a step's agent has no deadline and no outage limit.

Any other failure would only repeat, such as a VM the runner refuses, a gone agent, a stored row that no longer decodes, an import OpenCode refuses or a root session removed inside the VM: the output is discarded, the chat becomes `failed`, and its VM is removed. The next input posted to it tries again; a server start doesn't.

A stop interrupts the execution, which removes its VM, discards its output and records `interrupted`. It cancels nothing: the inputs the execution had taken are pending again beside those still queued, and they run with the next input posted.

## When an execution is done

OpenCode says when it is done, by its own state: every input sent, no session active, no shell running, every known session's inbox empty, and every background subagent reported. The events naming OpenCode's last writes can arrive after it reports done, so the execution then reads every session again and checks once more. It then saves `/work`, and in one transaction checks that no input came in, records the root session's outcome as the chat's status (`failed`, `interrupted`, or none), commits its output and runs `ended`; then its VM is removed. A post's transaction can't interleave with that one, so an input saved meanwhile either goes to this VM first or finds the status cleared and wakes a new execution. A stop that recorded `interrupted` first wins, and the execution commits nothing.

Background subagents are the trap. A completed `subagent` tool call whose metadata says `status: running` started background work, including a call OpenCode moved to the background. Once that child ends, nothing is active until its report reaches the parent as a synthetic message with `metadata.source: "subagent"` and its `childID`, so idleness alone would remove the VM before the report. The agent can continue the same child in the background again, so launches and reports are counted per child, by tool call and by message. The tracking is the attempt's own memory, built from what it captured; the imported conversation owes it nothing, since an execution commits only once every background subagent reported.

The execution relies on an open question keeping its session active, so a waiting chat keeps its VM until the question is answered or dismissed, or the chat is stopped; nothing times it out. Answers and dismissals go to the running execution's VM, and with none the question is gone. They are not inputs, so an execution that doesn't finish loses them: the next one sends its inputs again, and the agent may ask again.

## The workspace

Only a finished execution saves `/work`, through the runner, which leaves out what every start writes again and rebuildable caches ([sandboxed chats](./sandboxed-chats.md#chats)); what a discarded execution changed there goes with its VM. The tarball is written beside the last one and renamed in, so a save cut short keeps the last good one, as does a save the runner refuses. There is no size limit, by decision: the tarball is held whole in the runner's and the server's memory on its way, so a workspace grows until one of them, or a disk, runs out.

The save is not part of the commit: it lands before the transaction, so a stop or crash between the two leaves `/work` as an execution whose output was discarded left it.

## Ids

A chat's id and agent never change. Its single origin is either a member-owned Conversation or a triggered Task, stored in `chat_origins` and created atomically with the chat and first input. Task identity is chat identity; a retry after a final outcome gets a new pair. The origin remains with the chat tombstone. Chat storage and execution events carry neither member ownership nor workflow references.

The root session is `ses_t45_<chat>` and an input's message `msg_t45_<chat>_<input>`, so every execution names them the same and an input's stored user message tells it is taken. Subagent sessions and the agent's messages take OpenCode's ids, which import keeps; what an execution writes again after a discard gets new ones. Every native row is also keyed by chat, since one VM must never write into another chat's copy. Capture assigns session-local ordinals because T45's ids do not sort with OpenCode's.

## Executions and tasks

An execution calls a fixed interface defined in `chats` and implemented by TaskService: whether the chat may ask questions, messages just saved, and the execution ended, inside the transaction that records its status. Hooks run on the execution's fiber and receive its file reader. They must never stop the execution themselves: `RunnerService.stop` interrupts the execution and waits for it. A task settling in a hook goes through ChatService's `requestStop`, which records `interrupted` in the caller's transaction and runs the stop on its own fiber after commit.

TaskService starts, continues, stops and settles tasks. A stop leaves a task active, and step submission is provisional until approval; rejection continues the same task and chat. Settlement rechecks pending inputs in its transaction, so an ended execution is not a verdict while the task is still owed work. The call ledger and workflow effects commit together.

Discarded and re-sent inputs repeat workflow side effects. The saved-messages hook applies step calls as capture saves them, before the execution commits, and the ledger keys them by native message and part ids; the execution that sends an input again writes new ones, so a step call the agent makes again is applied again, and discarding the output undoes nothing that committed. This gap is deliberate for now and recorded in `todo.md`.

## Streams

The execution holds the VM's `/api/event` stream, through the runner, as the chat's only upstream. The stream only marks what to read again and forwards text and reasoning deltas, so it never falls behind; capture then pages each marked session and upserts by id. Deltas are never stored: the browser appends one to the part its ordinal names among the message's parts of that kind, and a new copy of a live message keeps text streamed past it, since OpenCode fills a part only when it ends.

The `ChatService` layer provides one `ChatEvents` bus shared by posts, the runner and member streams; a second bus is a list or an open chat that stops updating. A stream subscribes before it reads its snapshot, and holds at most 1,000 changes it hasn't sent, since a client that stops reading keeps its request open; past that it drops them and sends a fresh snapshot.

## Delete

Deleting tombstones the chat. After commit its execution is stopped, and the chat's hold on its files, the files nothing else holds, its workspace and its rows are removed; a cleanup cut short is finished at the next server start. The tombstone retains its origin and final Task outcome, so access and identity remain resolvable, and normal reads exclude it.

A chat exists from its first input on: a member's new chat is a page the web keeps until its first send carries the agent, so an empty chat leaves nothing behind.

## Locks and waits

Nothing inside a transaction waits on an execution, the per-chat input lock or the registry, and the registry runs no SQL. SQLite has one connection, so a transaction that waits on work needing SQL stalls every request. Public VM commands (answer, dismiss, cancel) run outside transactions on the running VM and give up after a minute. Task hooks read and store attachment snapshots before opening the transaction that records calls and applies workflow effects.

## OpenCode traps

Checked against the v2.1.4 source; check them again when bumping the pin.

- **Admission is by caller id, not content.** The same message id with other text or metadata is accepted and the first payload kept. Message ids are a global primary key: the same id in another session, or as a synthetic, is a `ConflictError`.
- **Inbox cancel leaves no tombstone.** It deletes the entry and answers 204 even when nothing was there, and the same id is admitted again afterwards with new content.
- **Import round-trips what `message.list` pages return**, ids, order, encoded content, idle markers and inputs with their `metadata.t45` included, and drops unsettled messages. A child before its parent is `SessionNotFoundError`; importing again is 409. `parentID` and model are kept; `location.directory` becomes the target server's. Re-sending an imported input id with `resume: false` returns that message and queues nothing; with the default `resume` it appends an empty idle turn.
- **A session can be removed from inside the VM**, by an agent or plugin with the server's password. Removing one interrupts it, removes its children too, and publishes `session.deleted` for each. A missing session creates nothing: a prompt, `message.list`, `inbox.list` or `session.get` on it is `SessionNotFoundError`. A removed subagent keeps what capture saw of it; a removed root fails the chat, since it isn't a lost connection.
- **`/api/event` registers its subscriber just before the first frame, `server.connected`.** Events between the HTTP 200 and that frame are missed, so start work only after it. A subscriber more than 4,096 frames behind is failed.
- **`opencode serve` outside a VM** needs its own HOME, XDG dirs and TMPDIR, or it writes into the shared `/tmp/opencode`. Without a key its built-in provider serves free models from opencode.ai, which a session without a model falls back to, and the server fetches its model catalog from models.opencode.ai at start and every five minutes; `OPENCODE_DISABLE_FREE_MODELS=1` and `OPENCODE_DISABLE_MODELS_FETCH=1` turn both off. A session whose pinned model is unavailable fails its turn instead of falling back. In a VM the network only reaches opencode.ai with T45's key, so this matters only for tests.

## Tests

Chat tests run the real services over test SQLite against the fake runner and fake OpenCode servers in [`apps/server/src/runner`](../../apps/server/src/runner) and wait on the chat's change feed.
