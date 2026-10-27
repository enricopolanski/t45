# Provider constraints

OpenCode is the only agent runtime, and T45 drives it from one place: a chat's worker ([chats](./chats.md)), which reaches the VM's OpenCode server through [`OpenCode2Client`](../../apps/server/src/opencode/OpenCode2Client.ts). A step's agent works in a chat like any other ([sandboxed chats](./sandboxed-chats.md)).

A chat names its agent, and the agent alone decides the model and the permissions; nothing past agent setup chooses or reads a model or provider.

## Process and account isolation

T45 never installs, updates or spawns OpenCode on the server. Each chat gets its own VM on the runner, which boots the agent's setup and its own [OpenCode server](../../apps/runner/src/MicrosandboxChats.ts); T45 reaches it through the runner, with the runner's token as the password.

Every session's rules allow every tool (`sessionRules`) but one: the agent's sandbox is what confines it. T45 has no approval prompt and answers no permission ask; chats rely on the rules alone.

## Questions

A question blocks its session and lives only in the VM that asked it. A chat keeps a copy of each pending form, since members read only from T45, but an answer goes to the VM that asked. A question keeps its chat awake for up to 30 minutes and is then cancelled; one whose VM went away is gone, and the restore note tells the agent. Only Conversations allow questions. TaskService's worker hook denies OpenCode's `question` permission for Tasks on creation and restoration, regardless of the agent's discovery flag; native subagents cannot ask questions either.

## Attachments

Attachments live on the server, outside every VM, in [one store](../../apps/server/src/attachments/AttachmentRepository.ts) for chat and step files alike: the bytes are files in the server's attachments directory, and a row says who holds each. A step holds the files attached to it and a chat the files sent to it; an upload nothing holds yet is pending, its uploader's alone, and swept a day after it was made. Pending is a row state, so sending moves no bytes: a chat's input or answer checks every file and binds them all to the chat in one transaction, or binds none. A member sends only their own pending uploads; T45 sends a step's chat only files a step holds, so no member can send a step's file and T45 can't send a member's pending one. A step's file reaches each chat it is sent to as another binding of the same row, never a copy, and taking it off the step leaves the chats' bindings, so a chat's history keeps its files; taking a file off its step or deleting a chat removes the files nothing else holds, so a file never goes back to pending. Bytes are written and removed outside every transaction: an upload is renamed into place before its row exists, so the sweep removes a row-less file only once it is a day old, and a file taken off its step loses its row in the step's transaction and its bytes to the sweep. A chat's worker puts the chat's files into the VM's `/work/attachments/` at every boot and before delivering the input that sent them, and the prompt names them there; a file the runner refuses is skipped with a warning. A path in the prompt grants no filesystem access; the sandbox decides what an agent can read.
