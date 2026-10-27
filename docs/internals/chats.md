# Chats

OpenCode runs a chat; T45 keeps it. The code is in [`apps/server/src/chats`](../../apps/server/src/chats), the VM boundary and workflow tool receipts in [sandboxed chats](./sandboxed-chats.md).

## T45 owns the chat; the VM keeps nothing

T45 stores each chat's OpenCode sessions and messages as OpenCode returned them, the inputs members sent, the questions waiting, and a tarball of the agent's `/work`. A chat's VM is made fresh from the agent's current setup whenever the chat has work, and removed when it sleeps. Every new boot is restored the same way, so restore can't quietly break: put the chat's attachments, unpack the workspace, post each session to OpenCode's own import (`POST /api/experimental/session/import`) parents first, then re-send the inputs OpenCode doesn't hold. A boot is new when the runner's `bootId` differs from the one the chat last restored into.

Stored messages are OpenCode's wire JSON, decoded with the pinned `@opencode` schemas. They are never cut, since import needs them whole; reads cut long strings to 8,000 characters and drop inline file `data`, and only `chats.getMessage` sends a message whole. Bumping the OpenCode pin means every stored row must still decode, or reading it fails.

The root session's import carries the chat's current title and the agent's current model, so a model change reaches a chat at its next boot. A root that import refuses for any reason but 409 is created empty and the chat goes on without its history; a child that fails is logged and skipped. An import that finds the VM out of reach fails the boot instead. Above 4,000 settled messages a session imports from its latest completed compaction, which gives the model the same context; T45 keeps the full history either way.

## One worker per awake chat

A chat's worker is the only fiber that talks to its VM: it boots, restores, delivers and captures, one thing at a time, so a capture answered by an old VM can't land after a restore. Everything that posts to a chat only writes the input ledger, and the worker wakes once that commits. Work that needs the VM, such as answering a question or withdrawing an admitted input, runs on the worker as a job, and a stop is a request the worker carries out (see [the input ledger](#the-input-ledger)); a job finds no VM rather than starting one, except compaction, which boots. A caller waits 3 minutes for its job; one it gave up on is skipped, or interrupted if it runs, so it never takes effect after its caller heard it failed.

A post wakes the worker after it commits: [`ChatService.post`](../../apps/server/src/chats/ChatService.ts) publishes a `posted` change through `SqlClient.afterCommit`, which runs once the outermost transaction commits, is dropped with a savepoint that rolls back, and runs at once outside a transaction. The worker subscribes to `posted` while its layer is built, before startup reads which chats need it. Its registry decides from the mailboxes alone and runs no SQL, so no after-commit callback waits on the database or a VM. Public commands use the same after-commit wake; an explicit stop also cancels waiting inputs under the delivery lock.

A wake lost between `COMMIT` and its callback, or published where nobody listens, is what the sweep is for: every 30 seconds and on a `missed` change, every chat with a stop request, an awake VM, or open inputs while not failed gets a worker if it has none, and one with a stop request is woken even if it has. The sweep at start also takes failed chats that hold open inputs, and each one's worker tries it once more; the periodic sweep doesn't, so a VM the runner refuses isn't retried every 30 seconds.

A boot that fails because the runner is out of reach, or the VM's server doesn't answer (no connection, or 502 to 504 from the runner's proxy), is tried again at once, then less and less often, up to every 30 seconds. OpenCode's client wraps such a request failure in a `ClientError`, so the worker looks at its cause. Any other failure, such as a VM the runner refuses or a stored message that no longer decodes, would only repeat: the chat shows as failed and its worker stops until the chat's next message, or the next server start while it holds open inputs. A VM it had started is left to the startup sweep or the runner's backstop.

The worker holds the VM's `/api/event` stream, through the runner, as the chat's only upstream. The stream only marks what to read again and forwards text and reasoning deltas, so it never falls behind; capture then pages each marked session forward from its cursor, re-reads its unfinished messages, and upserts by id. A user message whose id is in the ledger marks that input materialized in the same transaction. Deltas are never stored: the browser appends one to the part its ordinal names among the message's parts of that kind, and a new copy of a live message keeps text streamed past it, since OpenCode fills a part only when it ends. An open stream holds at most 1,000 changes it hasn't sent, since a client that stops reading keeps its request open; past that it drops them and sends a fresh snapshot instead.

A replaced VM shows as a new `bootId` once its stream ends. A session the VM no longer holds was removed inside it: a subagent's is let go and its unfinished messages become `lost`, and without the root the worker forgets the chat's boot and restores into the same VM. A stream that ends is reconciled in full on reconnect; nothing is replayed.

## What a dead VM loses

Unfinished messages become `lost` and show as interrupted; OpenCode's import would drop them anyway. Waiting questions are gone, `/work` goes back to its last save, and running processes stop. In the same transaction that marks messages lost and drops questions, T45 ends the root session with a synthetic note saying what was lost, so a restore cut short still imports it and the agent reads it. Only `live` rows become `lost`; settled rows are never removed. Origin policy decides recovery: Conversations wait for their member; active Tasks may receive one bounded carry-on. Blocked steps, submitted Tasks and settled Tasks cannot recover automatically. The policy is checked in the same transaction as the recovery input, with open-input, stop and consecutive-carry-on suppression.

Capture is T45's, so whatever settles while T45 is down stays only in the VM until T45 is back and catches up. A VM that dies meanwhile, or that the runner's backstop removes, takes that with it. An input such a VM had admitted and run is still `admitted` in the ledger, so the next boot sends it again and it runs twice, its first result gone.

## Ids

A Chat's id and agent never change. Its single origin is either a member-owned Conversation or a triggered Task, stored in `chat_origins` and created atomically with the Chat and first input. Task identity is chat identity; a retry after a final outcome gets a new pair. The origin remains with the chat tombstone. Chat storage and execution events carry neither member ownership nor workflow references.

The root session is `ses_t45_<chat>` and an input's message is `msg_t45_<chat>_<input>`, so retry and restore name the same native message. Subagent sessions use OpenCode's ids. T45 notes use `msg_t45_<chat>_<kind>.<key>`; input ids cannot contain a dot. Every native row is also keyed by chat, since one VM must never write into another chat's copy. Capture assigns session-local ordinals because T45's ids do not sort with OpenCode's.

## Execution and task outcomes

The worker calls a fixed interface defined in `chats` and implemented by TaskService: resolve question/recovery policy, handle messages just saved, and handle a turn ending after saving its final status. Hooks run on the worker and receive its file reader; they must never queue work back onto it with `runner.run`. There is no task follower or event-routing state.

TaskService starts, continues, stops and settles tasks. A stop leaves a task active; a blocked step prevents its continuation and recovery. Step submission is provisional until approval, and rejection continues the same task and chat. The ending hook receives the computed status after each reconciliation, including unchanged endings after a crash. Lost turns remain interrupted even if OpenCode retains an earlier success. Settlement rechecks open inputs in its transaction; chat idle alone is not a business verdict. The call ledger and workflow effects commit together.

The worker tracks background reports in memory for its current VM boot, updated from messages each capture writes. Native completed `subagent` calls with metadata `status: running` identify background work, including calls moved to the background by OpenCode. An ended child whose report has not reached its parent prevents completion and sleep. A new worker starts with nothing outstanding; pending reports are not reconstructed after a server restart. Normal status and sleep checks use only the in-memory tracker.

## The input ledger

`chat_inputs` says where each input stands: `waiting` (only T45 holds it), `admitted` (OpenCode's inbox holds it too), `materialized` (capture saw its user message) or `cancelled`. An input is saved, its files bound to the chat, before the send is answered. Its payload is stored as JSON from one encoder, and the same input id again is a no-op when its payload encodes the same and an `input_conflict` otherwise: OpenCode admits a repeated id with any payload and keeps the first, so T45 compares. The comparison comes before any other check, so a retry of a saved input stays a no-op and wakes the worker again.

ChatService’s private posting and stopping callbacks only save rows and publish after commit. TaskService and member commands share these commands; nested calls use the caller's transaction. Workflow views read historical agent identity from the chat tombstone. Starting a Chat requires an active agent; Conversation creation additionally checks member discovery, and workflow entries require step tools. `isConversational` controls discovery, never execution authority or question/recovery policy.

A stop is a request stored on the chat (`stop_through`), not a job. It is a position: it covers every input up to the highest ordinal when it was written, so an input committed after it is delivered, and a second request only widens it. Every stop cancels covered inputs and interrupts running work. Only the chat's worker carries it out: at the top of each pass, after a boot's first reconcile, and before each delivery, taking the delivery lock to cancel; delivery itself cancels a covered input instead of prompting it, so an older send never overtakes a stop. The worker clears the request compare-and-set, so a wider one written during its VM calls stays for the next pass. A member's Stop also cancels at once, under the delivery lock, the waiting inputs it covers, so what only T45 holds stops even while the runner is out of reach. A stop on a sleeping chat boots nothing: the worker cancels in the ledger and boots only for what the chat is still owed; on a new boot it cancels in the ledger the admitted inputs a stop covers, since the fresh VM never held them.

A `waiting` input is cancelled under the worker's delivery lock, so it can't be mid-prompt. An `admitted` one is withdrawn from OpenCode's inbox and then looked up: if OpenCode had already delivered it, it is `materialized` and the cancel is `already_taken`. OpenCode keeps no tombstone, so only the ledger remembers a cancel, and only `waiting` and `admitted` inputs are ever sent again. Never re-send a materialized id with the default `resume`: OpenCode appends an empty turn. An input OpenCode refuses (`InvalidRequestError` or `ConflictError`) would be refused at every delivery, so it is `cancelled` and a note in the root session tells members.

## The workspace snapshot

After a turn ends with nothing running, and before a chat sleeps unless that save already happened, the runner packs `/work` into a gzipped tarball and T45 stores it under the server's state directory, written beside the old one and renamed in, so a save cut short keeps the last good one. What every boot writes (`attachments/`, `AGENTS.md`, `opencode.json`, `.opencode/skills`) and rebuildable caches (`node_modules`, `.venv`, `__pycache__`, `.cache`) are left out, as are files the agent can't read, and unpacking never overwrites what the boot wrote. There is no size limit, by decision: the tarball is held whole in the runner's and the server's memory on its way, so a workspace grows until one of them, or a disk, runs out. A save the runner refuses three times in a row is given up, so the chat can still sleep: the last good snapshot stays, and the first give-up in a row adds a note that T45 stores at once and posts to the VM without starting a turn. A boot that can't unpack the snapshot adds a note saying so to the root session before importing it. The runner adds to the agent's instructions what survives.

## Sleep and the runner's backstop

Sleeping is T45's decision. A chat sleeps after 5 idle minutes with no input open, no session active, no shell running, nothing in OpenCode's inbox but T45's own workspace note, nothing `live`, no outstanding background report, and the workspace saved since the last turn; a question keeps it awake up to 30 minutes, then is cancelled. A synthetic T45 posts with `resume: false` waits in the inbox until the next turn, so any new one must be excluded from that check as the workspace note is, or the chat never sleeps. The chat is recorded asleep before its VM is removed.

The runner keeps a backstop: a chat VM with no request open to it for 45 minutes is removed, which lets go of VMs T45 lost. At start T45 finishes deletes cut short, removes every chat VM the runner lists that no chat wants (recorded awake, holding open inputs, or with a stop request), and starts workers for the rest, so a database wipe leaves nothing behind.

## Delete

Deleting tombstones the chat. Then the worker stops, and the VM, the chat's hold on its files, the files nothing else holds, the workspace and the stored copy are removed, retried every 30 seconds until done. The tombstone retains its origin and final Task outcome, so access and identity remain resolvable. Normal chat and worker reads exclude tombstones. Cleanup waits for the worker to stop before removing its native rows.

A chat exists from its first input on: a member's new chat is a page the web keeps until its first send carries the agent, so an empty chat leaves nothing behind.

## Locks and waits

The worker's delivery lock can wait on SQL and the VM. Its registry handles only mailboxes and never waits on SQL. Task hooks read and store attachment snapshots before opening the transaction that records calls and applies workflow effects. They cannot queue a job on their own worker. Public VM commands use `RunnerService.run` outside transactions.

Nothing inside a transaction waits on a worker lock, the registry or a queued job, and the registry runs no SQL. Two things would close a cycle: SQL under the registry lock, and a chat command that waits on a lock or a VM job inside a transaction. ChatService’s private posting and stopping callbacks only save rows and publish after commit; TaskService calls these from source and lifecycle transactions. SQLite has one connection, so the second stalls every request until the 3-minute job timeout.

The `ChatService` layer provides one `ChatEvents` bus shared by its input writer, the runner and member subscriptions. A second bus is a wake nobody hears until the next sweep, and a list or an open chat that stops updating.

## OpenCode traps

Checked against the v2.1.4 source; check them again when bumping the pin.

- **Admission is by caller id, not content.** The same message id with other text or metadata is accepted and the first payload kept. Message ids are a global primary key: the same id in another session, or as a synthetic, is a `ConflictError`.
- **Inbox cancel leaves no tombstone.** It deletes the entry and answers 204 even when nothing was there, and the same id is admitted again afterwards with new content.
- **A session can be removed from inside the VM**, by an agent or plugin with the server's password. Removing one interrupts it, removes its children too, and publishes `session.deleted` for each.
- **A missing session creates nothing.** A prompt, synthetic, `message.list`, `inbox.list` or `session.get` on it is `SessionNotFoundError`.
- **Import round-trips what `message.list` pages return**, ids, order, encoded content, idle markers and T45's notes with their `metadata.t45` included, and drops unsettled messages. A child before its parent is `SessionNotFoundError`; importing again is 409. `parentID` and model are kept; `location.directory` becomes the target server's. Re-sending an imported input id with `resume: false` returns that message and queues nothing; with the default `resume` it appends an empty idle turn.
- **`resume: false` never makes a message.** A prompt or synthetic sent so waits in the inbox until the session next wakes.
- **A waking session delivers its inbox before it resolves the model**, so an input can materialize in a turn that then fails; the user message keeps `metadata.t45` as sent.
- **`/api/event` registers its subscriber just before the first frame, `server.connected`.** Events between the HTTP 200 and that frame are missed, so start work only after it. A subscriber more than 4,096 frames behind is failed, and `opencode serve` replays nothing: on reconnect, reconcile everything.
- **`opencode serve` outside a VM** needs its own HOME, XDG dirs and TMPDIR, or it writes into the shared `/tmp/opencode`. Without a key its built-in provider serves free models from opencode.ai, which a session without a model falls back to, and the server fetches its model catalog from models.opencode.ai at boot and every five minutes; `OPENCODE_DISABLE_FREE_MODELS=1` and `OPENCODE_DISABLE_MODELS_FETCH=1` turn both off. A session whose pinned model is unavailable fails its turn instead of falling back. In a VM the network only reaches opencode.ai with T45's key, so this matters only for tests.

## Tests

Chat tests run the real service and worker over test SQLite against a fake runner and fake OpenCode servers ([`apps/server/src/runner`](../../apps/server/src/runner) testkits) and wait on the chat's change feed ([`Chats.testkit.ts`](../../apps/server/src/chats/Chats.testkit.ts)).
