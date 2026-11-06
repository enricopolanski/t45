# Runner boundary: implementation notes

## The design as implemented

[Chats](../internals/chats.md) and [sandboxed chats](../internals/sandboxed-chats.md) describe it. T45 asks the runner to `execute` the chat with everything it starts from and keeps what the stream returns; the runner owns the VM and its disk, OpenCode, input delivery, reading and completion.

## Changed shape, worth knowing

- **No stop request.** An execution lasts as long as its `execute` call, and the runner removes the VM when the call ends. A stop asks the chat's owner to end the call; a separate stop request could overtake an `execute` call still in flight and leave the agent running.
- **Only the posted input is sent.** A running execution gets each input as it is posted; the full pending list goes only into a new execution.
- **Late inputs run in a new VM.** The runner finishes once OpenCode is done with every input it has. An input that reaches it while the VM boots, or once it has finished, is dropped; T45 commits the finished output, keeps the chat `running` while an input is pending, and a new execution runs it.
- **No restarts.** A lost VM, an event stream that ends or goes silent, or an unreachable runner fails the execution, and the chat stays `failed` until its next input.
- **Heartbeats.** The runner sends one every 15 seconds on each execution, since fetch ends a response body silent for 5 minutes.
- **Cancel window.** A cancel between T45 reading the pending inputs for an execution and the runner sending them to OpenCode finds nothing to withdraw, and the agent answers the input anyway.
- **The disk replaces `/work` and session import.** A VM boots on the chat's saved ext4 disk, whole writable layer included, so packages the agent installs and OpenCode's own database survive; the runner creates the root unless the disk has it and switches its model, and no longer imports the conversation. `execute` carries only the pending inputs' files, since earlier ones are on the disk.
- **OpenCode's own notes now show up.** Its instruction state persists on the disk, so a chat gets a `model-switched` message when the agent's model changes, an "Instructions updated" message when AGENTS.md or a skill changes, and a date note on the first turn of a new day; the timeline already renders all three.

## Open, needs your decision

1. Discarded and re-sent inputs repeat workflow side effects (step tools), because the tool-call ids are new. Deferred in `todo.md`.
2. A crash or shutdown between saving a disk and committing its output leaves the disk ahead: OpenCode then answers the re-sent inputs with an empty turn each, and the next execution reads the discarded turns back. A pointer column flipped in the commit would close it.
3. A saved disk only grows: ext4 keeps a deleted file's bytes, so the archive doesn't shrink after the agent deletes, up to the disk's fixed size. `fstrim` in the guest before removal is untested.
4. The runner's host needs `mkfs.ext4` and GNU tar, which macOS lacks by default.
