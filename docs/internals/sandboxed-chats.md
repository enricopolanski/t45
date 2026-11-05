# Sandboxed chats

No agent runs on T45. Every execution of a chat runs in its own new VM on the runner (`apps/runner`); T45 keeps the chat's inputs, its conversation and the VM disk its last finished execution left, and hands the disk and the inputs the agent hasn't taken to the runner with every `run`, which boots a new VM on the disk and sends it the inputs. T45 never talks to OpenCode, and the VM has no route to T45. [Chats](./chats.md) explains executions, how they restore and how they end.

T45 sends its tools as agent files under `/work/runtime` for agents with enabled built-in MCP servers; the directory is reserved from editable agent files and cleared at every start, and the image carries no T45 code.

## Workflow effects cross the boundary as native tool calls

The step tools (`STEP_TOOLS_MCP`, `step-tools.mjs`) return receipts without mutating T45. Dependencies flow from WorkflowService to TaskService to ChatService to RunnerService. TaskService consumes executions through ChatService, using WorkflowService's receipt functions to apply calls and task transitions in one transaction. A receipt saying `ok: true` means the VM accepted the call; workflow refusals return as input to the same task.

Each native message/part key is checked before attachment preparation and recorded in `task_calls` in the transaction applying its effect; an input sent again after a discard writes new keys, so a repeated call applies again (see [Chats](./chats.md#executions-and-tasks)). Receipts ignored after submission are consumed too. `step_done` requires every required field and substep to be complete before submitting its task. Approval readiness is checked only when a task submits or the automation configuration changes. Rejection continues those tasks and chats, approval settles them, and `step_give_up` fails only its task.

The consumer and execution share a fiber, so stops cancel result handling directly, without an acknowledgement protocol, and nothing it needs lives in the VM. Chat and task completion commit together. Task and workflow commands save inputs and request stops after commit; a stop is only a request, so result handling never waits on its own execution.

## Fail closed

The server doesn't start without `RUNNER_URL` and `RUNNER_TOKEN`, and the runner doesn't start without any of its settings, among them `OPENCODE_API_KEY`, the OpenCode Go key every VM's model runs on. A VM the sandbox refuses, because it could not start (as without KVM), fails the chat, and with it a step's agent work; the reason goes to the runner's log. Nothing falls back to T45. A runner out of reach is only waited out (see [Chats](./chats.md)): a step's agent has no deadline and no outage limit.

## What a chat reaches

- **Network.** Deny by default, OpenCode Go's host allowed on 443. TLS interception is always on: microsandbox's strict mode refuses a domain rule without it, and it adds the `Host` check. The provider-only network has no DNS rule; one would resolve every name, which leaks through query names. With the network open, DNS goes through the host and the public internet is allowed, T45's and the runner's public addresses included: their endpoints authenticate every caller.
- **The key.** A microsandbox secret bound to OpenCode Go's host and substituted only in the `authorization` header. The guest holds a placeholder; sent anywhere else, it is refused.
- **Files.** A chat's files reach the runner with `run`, `send` and `answer`, and go into `/work/attachments`, at most 50 MiB each (`ATTACHMENT_MAX_FILE_BYTES`). Nothing of the host is mounted, and the host never writes a path the guest named. An attach copies the file to `/work/.t45/attached/<uuid>`, which every start clears. The runner reads every file there through OpenCode, as the agent, and sends it as a `file` event before the messages naming it; the workflow hook looks up the name the reply gives among the files the runner sent, so the agent can't point T45 at a file it didn't leave there. The hook reads and stores the snapshot as the agent's pending `application/octet-stream` file before the call transaction, which only claims the stored attachment and applies workflow changes; a refused attachment is left to the sweep. An attach whose snapshot never arrived, as when the agent removed it first, is refused in the chat, so the agent can attach the file again.

## Limits

2 vCPUs, 2 GB of memory and 4 GB of disk per VM, set by the runner (`LIMITS`). The memory is a cap, not a reservation: a VM uses about 0.5 to 0.8 GB, and CPU is the tighter limit, about one busy agent per vCPU. The runner has no cap on how many VMs run at once; a VM that can't start for lack of room is refused like any other. Running out of memory isn't named: a tool the kernel kills is just a failed call.

## Traps

- **`servers`, with `codemode: false`.** The step tools and workflow drafting sit under opencode.json's `mcp.servers`; OpenCode's older `mcp.<name>` form drops `codemode`, and the agent then calls them from its code tool, so no `step_*` parts appear in the chat.
- **Tool names come from server names.** OpenCode names an MCP tool `<server>_<tool>`, so `step_*` and `workflows_draft` match only while the servers keep the names `STEP_TOOLS_MCP` and `WORKFLOW_DRAFTING_MCP` give them.
- **The VM waits for every MCP server.** `opencode serve` answers before its MCP servers connect, and a turn started then finds no tools; so a start waits, about a minute at most, until `/api/mcp` reports every server of the agent connected. A server that never connects fails every chat of that agent, step chats included.

## Chats

A chat names its agent (`agentId`); the agent alone sets the model and the permissions. The agents members can chat with are the active ones with `isConversational`, which the web reads with `agents.list`. T45 keeps the chat and decides when it runs (see [Chats](./chats.md)); the runner runs the execution, and nothing in it outlives the VM but the disk a finished execution saved.

- **One server per VM, reached by the runner alone.** The runner talks to the VM's OpenCode on the host's loopback with a password made fresh at every start. The agent runs in the VM's `/work`, and a message's attachments go into `/work/attachments/` before it is delivered.
- **A VM is one attempt's.** An attempt replaces any VM left under its execution's id and makes a new one from the agent's setup, on its own copy of the saved disk; the runner removes the VM and the copy when the attempt finishes, fails or is lost, or when T45's `run` call ends. A removal that fails is only logged, except before a save, which it fails.
- **The disk goes through the runner.** A VM boots on an ext4 file in `/var/tmp` on the runner's host, not `/tmp`, which is often memory, attached in place as its writable layer over the image: the chat's saved disk, unpacked, or a new one from `mkfs.ext4`. A finished execution removes the VM, which flushes the file, and packs it with GNU tar, keeping it sparse; microsandbox's snapshots refuse a VM on a disk it doesn't own, and its restore drops the key's secret. Everything the agent changed survives, `/work`, its home, `/tmp`, the packages it installed and OpenCode's database; every start clears what it writes again and what the step tools left (`.opencode/skills`, `runtime`, `.t45`) before writing the agent's setup. An image change reaches a chat at its next execution, except for the files the agent changed.
- **A VM lasts as long as T45's call.** A crashed T45 drops its calls, so the runner removes their VMs; a VM whose removal failed stays until the chat's next execution replaces it or the runner restarts.
- **VMs go with the runner.** Every VM is ephemeral: microsandbox removes it once it stops, and when the runner that made it dies; a runner that dies leaves its disk copies in `/var/tmp`. Sandbox names carry their runner's port, so runners sharing a machine, as dev checkouts do, never touch each other's. A VM that crashes is lost, and the runner starts the execution again in a new one; one that goes with the runner fails T45's call, and T45 runs it again.
- **Sealed.** The VM's network is the agent's, and nothing in the VM can reach T45. Inbound traffic is allowed, but the only way in is the port published on the host's loopback.
- **Workflow drafts are data.** Workflow drafting is an MCP server admins add to an agent (`WORKFLOW_DRAFTING_MCP`): the injected `workflow-tools.mjs`, which validates the same draft contract the web reads. Its `workflows_draft` call is a tool part of the chat's messages, which the web shows as a card only under that server name. The tool and chat use the blueprint input schema, including step and field IDs. Saving creates the blueprint through the ordinary API, as the member; the server validates the saved definition. A member's chat changes nothing in T45 any other way: only a step's chat does, and only on the step named by its task trigger. No agent acts as a person.
