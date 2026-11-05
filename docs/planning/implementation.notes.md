# Runner boundary: implementation notes

## The design as implemented

[Chats](../internals/chats.md) and [sandboxed chats](../internals/sandboxed-chats.md) describe it. T45 asks the runner to `run` an execution with everything it starts from and keeps what the stream returns; the runner owns the VM, OpenCode, restore, input delivery, capture, completion and restarts after a lost VM.

## Changed shape, worth knowing

- **No stop request.** An execution lasts as long as its `run` call, and the runner removes the VM when the call ends. A stop asks the chat's owner to end the call; a separate stop request could overtake a `run` still in flight and leave the agent running.
- **Only the posted input is sent.** A running execution gets each input as it is posted; the full pending list goes only into a new `run`.
- **Late inputs run in a new VM.** The runner finishes once OpenCode is done with every input it has. An input that reaches it after that is dropped; T45 commits the finished output, keeps the chat `running` while an input is pending, and a new execution runs it.
- **Restarts back off from the first loss.** A lost VM waits 1, 2, 4 and up to 30 seconds before the next attempt; the old server restarted at once when the lost attempt had reached its VM.
- **Heartbeats.** The runner sends one every 15 seconds on each `run`, since fetch ends a response body silent for 5 minutes.
- **Cancel window.** A cancel between T45 reading the pending inputs for a `run` and the runner receiving it finds nothing to withdraw, and the agent answers the input anyway.
- **The disk replaces `/work` and session import.** A VM boots on the chat's saved ext4 disk, whole writable layer included, so packages the agent installs and OpenCode's own database survive; the runner creates the root unless the disk has it and switches its model, and no longer imports the conversation. `run` carries only the pending inputs' files, since earlier ones are on the disk, so a file the sandbox refused in a finished execution is never put again.
- **OpenCode's own notes now show up.** Its instruction state persists on the disk, so a chat gets a `model-switched` message when the agent's model changes, an "Instructions updated" message when AGENTS.md or a skill changes, and a date note on the first turn of a new day; the timeline already renders all three.

## Open, needs your decision

1. Discarded and re-sent inputs repeat workflow side effects (step tools), because the tool-call ids are new. Deferred in `todo.md`.
2. A refused input's row is deleted at once, but its note is saved uncommitted. If that execution then doesn't finish, the note is discarded too, and the input disappears with no explanation.
3. The retry while the runner is out of reach (`RpcClientError` in `ChatExecutions.ts`) has no test: the in-memory RPC client can't produce that error.
4. A crash or shutdown between saving a disk and committing its output leaves the disk ahead: OpenCode then answers the re-sent inputs with an empty turn each, and the next capture brings the discarded turns back. A pointer column flipped in the commit would close it.
5. A saved disk only grows: ext4 keeps a deleted file's bytes, so the archive doesn't shrink after the agent deletes, up to the disk's fixed size. `fstrim` in the guest before removal is untested.
6. The runner's host now needs `mkfs.ext4` and GNU tar, which macOS lacks by default.
