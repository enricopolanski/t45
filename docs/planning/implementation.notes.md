# Send, stream, destroy: implementation notes

## The design as implemented

- T45 keeps three things per chat: its inputs, the conversation its executions wrote (OpenCode sessions and messages), and `/work` as of the last finished execution (a tarball).
- A chat has at most one execution at a time, and only while its `chats.status` is `running`. A post sets `running`, and a server start reruns those chats.
- An execution:
  1. drops any uncommitted output;
  2. starts a fresh VM (`startChat`);
  3. puts back `/work`;
  4. imports the committed conversation with OpenCode's session import;
  5. sends the pending inputs, those whose user message isn't stored;
  6. streams and stores the output.

  Inputs posted while it runs go to the same VM.

- **Finish:** OpenCode is idle by its own signals: no active session, no running shell, empty inboxes, and every background launch has reported (counted per launch, since the agent can continue a subagent). The execution then reads every session once more and checks again, saves `/work`, and in one transaction checks no input came in, commits what it wrote together with its status, then removes the VM.
- Every new VM gets all the files sent to the chat in `/work/attachments/`.
- **Anything that doesn't finish** has its uncommitted output discarded, so the next execution re-sends those inputs:
  - a lost connection restarts at once;
  - stop ends the execution (`interrupted`) and waits for the next send;
  - any other failure ends it as `failed` and waits for the next send.
- **Cancel** works only on pending inputs. It withdraws the input from the running VM's inbox if it was sent there.
- **Removed:**
  - boot ids, awake/asleep, idle timers and the question timeout;
  - per-input states, `stop_through`, sweeps and the job queue;
  - restore notes and the resume prompt;
  - the `lost` message state;
  - `chats.compact`;
  - the runner's connection counting and 45-minute idle backstop: only T45 removes VMs, and leftovers stay until their chat's next execution or the runner restarts.

## Open, needs your decision

1. Discarded and re-sent inputs repeat workflow side effects (step tools), because the tool-call ids are new. Deferred in `todo.md`.
2. Found by the test agent while reading the code; no test reproduces either:
   - A refused input's row is deleted at once, but its note is saved uncommitted. If that execution then doesn't finish, the note is discarded too, and the input disappears with no explanation.
   - A send that arrives while a stop waits for the VM removal (up to 60 s) wakes the dying execution and is ignored; the stop then sets `interrupted`, and the input waits for the next send.
3. Reviewer's #5: a VM whose removal fails stays until that chat's next execution or the next server start, since nothing retries it now that the runner's backstop is gone. A fix means a retry that doesn't belong to an execution (a list of failed removals retried in the background, holding off that chat's next start while it runs), which is a backstop again, inside T45. Your call.

## Status

- Server, contracts, runner app, web, tests and docs follow this design.
- `vp run pre-commit` passes: format, lint, typecheck, knip and tests (144 server tests).
