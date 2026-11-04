# Provider constraints

OpenCode is the only agent runtime, and T45 drives it from one place: a chat's execution ([chats](./chats.md)), which reaches the VM's OpenCode server through [`OpenCode2Client`](../../apps/server/src/opencode/OpenCode2Client.ts). A step's agent works in a chat like any other ([sandboxed chats](./sandboxed-chats.md)).

A chat names its agent, and the agent alone decides the model and the permissions; nothing past agent setup chooses or reads a model or provider.

## Process and account isolation

T45 never installs, updates or spawns OpenCode on the server. Each execution of a chat gets its own VM on the runner, which starts the agent's setup and its own [OpenCode server](../../apps/runner/src/MicrosandboxChats.ts); T45 reaches it through the runner, with the runner's token as the password.

Every session's rules allow every tool (`sessionRules`) but one: the agent's sandbox is what confines it. T45 has no approval prompt and answers no permission ask; chats rely on the rules alone.

## Questions

A question blocks its session and lives only in the VM that asked it. A chat keeps a copy of each pending form, since members read only from T45, but an answer goes to the VM that asked, and an execution that doesn't finish loses both ([chats](./chats.md#when-an-execution-is-done)). Only Conversations allow questions. TaskService's `questions` hook denies OpenCode's `question` permission for Tasks on every session an execution creates or imports, regardless of the agent's discovery flag; native subagents cannot ask questions either.

## Attachments

Attachments live on the server, outside every VM, in [one store](../../apps/server/src/attachments/AttachmentRepository.ts) for chat and step files alike: the bytes are files in the server's attachments directory, and a row says who holds each. A step holds the files attached to it and a chat the files sent to it; an upload nothing holds yet is pending, its uploader's alone, and swept a day after it was made. Pending is a row state, so sending moves no bytes: a chat's input or answer checks every file and binds them all to the chat in one transaction, or binds none. A member sends only their own pending uploads; T45 sends a step's chat only files a step holds, so no member can send a step's file and T45 can't send a member's pending one. A step's file reaches each chat it is sent to as another binding of the same row, never a copy, and taking it off the step leaves the chats' bindings, so a chat's history keeps its files; taking a file off its step or deleting a chat removes the files nothing else holds, so a file never goes back to pending. Bytes are written and removed outside every transaction: an upload is renamed into place before its row exists, so the sweep removes a row-less file only once it is a day old, and a file taken off its step loses its row in the step's transaction and its bytes to the sweep. Every new VM gets all the files sent to its chat in `/work/attachments/`, which the saved `/work` leaves out, since the imported conversation names them there; an input sent to a running VM gets its files before delivery, and an answer before the reply; a file the runner refuses is skipped with a warning. A path in the prompt grants no filesystem access; the sandbox decides what an agent can read.
