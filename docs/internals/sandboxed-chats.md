# Sandboxed chats

No agent runs on T45. Every execution of a chat runs in its own new VM on the runner (`apps/runner`); T45 keeps the chat's inputs, its conversation and its `/work`, puts the conversation and `/work` back in each new VM, and sends it the inputs the agent hasn't taken. The VM has no route to T45. [Chats](./chats.md) explains executions, how they restore and how they end.

T45 writes its tools into `/work/runtime` of every VM it starts for agents with enabled built-in MCP servers; the directory is reserved from editable agent files and left out of the saved workspace, and the image carries no T45 code.

## Workflow effects cross the boundary as native tool calls

The step tools (`STEP_TOOLS_MCP`, `step-tools.mjs`) return receipts without mutating T45. Dependencies flow from WorkflowService to TaskService to ChatService to RunnerService. TaskService consumes executions through ChatService, using WorkflowService's receipt functions to apply calls and task transitions in one transaction. A receipt saying `ok: true` means the VM accepted the call; workflow refusals return as input to the same task.

Each native message/part key is checked before attachment preparation and recorded in `task_calls` in the transaction applying its effect; an input sent again after a discard writes new keys, so a repeated call applies again (see [Chats](./chats.md#executions-and-tasks)). Receipts ignored after submission are consumed too. `step_done` requires every required field and substep to be complete before submitting its task. Approval readiness is checked only when a task submits or the automation configuration changes. Rejection continues those tasks and chats, approval settles them, and `step_give_up` fails only its task.

The consumer and execution share a fiber, so result handling finishes before the VM is removed and stops cancel it directly, without an acknowledgement protocol. Chat and task completion commit together. Task and workflow commands save inputs and request stops after commit, with stops on a separate fiber so result handling never waits on its own execution.

## Fail closed

The server doesn't start without `RUNNER_URL` and `RUNNER_TOKEN`, and the runner doesn't start without `T45_RUNNER_TOKEN` and `OPENCODE_API_KEY`, the OpenCode Go key every VM's model runs on. A VM the runner refuses, because it could not start (as without KVM), fails the chat, and with it a step's agent work; the reason goes to the runner's log. Nothing falls back to T45. A runner out of reach is only waited out (see [Chats](./chats.md)): a step's agent has no deadline and no outage limit.

## What a chat reaches

- **Network.** Deny by default, OpenCode Go's host allowed on 443. TLS interception is always on: microsandbox's strict mode refuses a domain rule without it, and it adds the `Host` check. The provider-only network has no DNS rule; one would resolve every name, which leaks through query names. With the network open, DNS goes through the host and the public internet is allowed, but T45's and the runner's public addresses are denied (`T45_RUNNER_DENY_IPS`): they are public, not "the host".
- **The key.** A microsandbox secret bound to OpenCode Go's host and substituted only in the `authorization` header. The guest holds a placeholder; sent anywhere else, it is refused.
- **Files.** A chat's files go in through the runner's file endpoint, into `/work/attachments`, at most 50 MiB each (`ATTACHMENT_MAX_FILE_BYTES`). Nothing of the host is mounted, and the host never writes a path the guest named. An attach copies the file to `/work/.t45/attached/<uuid>`, which the saved workspace leaves out, and T45 reads that snapshot from the running VM (the workflow hook checks that pattern) by the name the reply gives; the agent can't point T45 at another path. The hook reads and stores the snapshot as the agent's pending `application/octet-stream` file before the call transaction, which only claims the stored attachment and applies workflow changes; a refused attachment is left to the sweep. An attach whose snapshot T45 can't read, as when the VM went away first, is refused in the chat, so the agent can attach the file again.
- **Addresses.** Sandboxes take their addresses from `T45_RUNNER_SANDBOX_POOL` (10.200.0.0/16 by default). Choose a pool that does not overlap the runner's network.

## Limits

2 vCPUs, 2 GB of memory and 4 GB of disk per VM, set by the runner (`CHAT_LIMITS`). The memory is a cap, not a reservation: a VM uses about 0.5 to 0.8 GB, and CPU is the tighter limit, about one busy agent per vCPU. The runner has no cap on how many VMs run at once; a VM that can't start for lack of room is refused like any other. Running out of memory isn't named: a tool the kernel kills is just a failed call.

## Traps

- **`servers`, with `codemode: false`.** The step tools and workflow drafting sit under opencode.json's `mcp.servers`; OpenCode's older `mcp.<name>` form drops `codemode`, and the agent then calls them from its code tool, so no `step_*` parts appear in the chat.
- **Tool names come from server names.** OpenCode names an MCP tool `<server>_<tool>`, so `step_*` and `workflows_draft` match only while the servers keep the names `STEP_TOOLS_MCP` and `WORKFLOW_DRAFTING_MCP` give them.
- **The VM waits for every MCP server.** `opencode serve` answers before its MCP servers connect, and a turn started then finds no tools; so a start waits, about a minute at most, until `/api/mcp` reports every server of the agent connected. A server that never connects fails every chat of that agent, step chats included.

## Chats

A chat names its agent (`agentId`); the agent alone sets the model and the permissions. The agents members can chat with are the active ones with `isConversational`, which the web reads with `agents.list`. T45 keeps the chat and decides when a VM runs for it (see [Chats](./chats.md)); the runner only runs the VM, and nothing in it outlives the VM but what a finished execution saved: its conversation and `/work`.

- **One server per chat, reached through the runner.** The chat's execution talks to the VM's OpenCode at `/chats/<chatId>/opencode/` with the runner's token as the Basic password; the runner swaps in the VM's own, made fresh at every start. The agent runs in the VM's `/work`, and a message's attachments go into `/work/attachments/` before it is delivered.
- **A VM is one execution's.** `startChat` removes any VM left of the chat, disk and all, and makes a new one from the agent's current setup; the execution removes it when it ends, fails or is stopped. A removal that fails is only logged.
- **The workspace goes through the runner.** `GET /chats/<chatId>/workspace` packs the running VM's `/work` as the agent into a gzipped tarball, skipping files the agent can't read and leaving out what every start writes (`attachments`, `AGENTS.md`, `opencode.json`, `.opencode/skills`, `runtime`), the step tools' snapshots (`.t45`) and rebuildable caches anywhere (`node_modules`, `.venv`, `__pycache__`, `.cache`); the agent's instructions say what survives. `PUT` unpacks a tarball inside the VM as the agent, where GNU tar leaves out members that would land outside `/work`, and with `--skip-old-files`, so what this start wrote wins over the saved copy (GNU tar refuses to run when `--no-overwrite-dir` is added to it).
- **Only T45 removes chat VMs.** An execution removes its VM when it ends; a VM whose removal failed, or one a crashed T45 left, stays until that chat's next execution replaces it or the runner restarts.
- **VMs go with the runner.** Every VM is ephemeral: microsandbox removes it, disk and all, once it stops, and when the runner that made it dies. Sandbox names carry their runner's port, so runners sharing a machine, as dev checkouts do, never touch each other's. A VM that crashes or goes with the runner is a lost connection to T45, which starts the execution again in a new one.
- **Sealed.** The VM's network is the agent's, and nothing in the VM can reach T45. Inbound traffic is allowed, but the only way in is the port published on the host's loopback.
- **Workflow drafts are data.** Workflow drafting is an MCP server admins add to an agent (`WORKFLOW_DRAFTING_MCP`): the injected `workflow-tools.mjs`, which validates the same draft contract the web reads. Its `workflows_draft` call is a tool part of the chat's messages, which the web shows as a card only under that server name. The tool and chat use the blueprint input schema, including step and field IDs. Saving creates the blueprint through the ordinary API, as the member; the server validates the saved definition. A member's chat changes nothing in T45 any other way: only a step's chat does, and only on the step named by its task trigger. No agent acts as a person.
