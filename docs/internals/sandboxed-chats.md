# Sandboxed chats

No agent runs on T45. Every Chat executes in its own VM on the runner (`apps/runner`); T45 owns its native OpenCode history, inputs, questions and workspace. The VM has no route to T45. [Chats](./chats.md) explains capture, restoration and turn endings.

A VM's `RunConfig` contains the agent's instructions, files, skills, MCP servers and network permission. The runner supplies limits and workspace persistence instructions; the chat worker selects the model on the root session. A boot is ready only after every configured MCP server connects. Workflow briefs and business authority stay outside the runner.

## Workflow effects cross the boundary as native tool calls

The step tools (`STEP_TOOLS_MCP`, `step-tools.mjs`) return receipts without mutating T45. The worker passes saved native messages to TaskService, which finds the task by chat id and invokes WorkflowService for step calls. A receipt saying `ok: true` means the VM accepted the call; workflow refusals return as input to the same task.

Each native message/part key is checked before attachment preparation and recorded in `task_calls` in the transaction applying its effect. Receipts ignored after submission are consumed too. `step_done` requires every required field and substep to be complete before submitting its task. Approval readiness is checked only when a task submits or the automation configuration changes. Rejection continues those tasks and chats, approval settles them, and `step_give_up` fails only its task.

The hook uses the worker's file reader directly for attachment snapshots. It must never call `runner.run`: waiting for a queued job from inside the worker would deadlock. Task and workflow commands only persist inputs and stop requests, waking the worker after commit.

## Fail closed

The server doesn't start without `RUNNER_URL` and `RUNNER_TOKEN`, and the runner doesn't start without `T45_RUNNER_TOKEN` and `OPENCODE_API_KEY`, the OpenCode Go key every VM's model runs on. A VM the runner refuses, because it can't sandbox (no KVM) or the VM could not start, fails the chat, and with it a step's agent work; the reason goes to the server's log and, while the runner can't sandbox, to the runner page. Nothing falls back to T45. The runner checks it can sandbox whenever a VM starts, and its inventory says whether it can and why not, so the server asks nothing first. A runner out of reach is only waited out (see [Chats](./chats.md)): a step's agent has no deadline and no outage limit.

## What a chat reaches

- **Network.** Deny by default, OpenCode Go's host allowed on 443. TLS interception is always on: microsandbox's strict mode refuses a domain rule without it, and it adds the `Host` check. The provider-only network has no DNS rule; one would resolve every name, which leaks through query names. With the network open, DNS goes through the host and the public internet is allowed, but T45's and the runner's public addresses are denied (`T45_RUNNER_DENY_IPS`): they are public, not "the host".
- **The key.** A microsandbox secret bound to OpenCode Go's host and substituted only in the `authorization` header. The guest holds a placeholder; sent anywhere else, it is refused.
- **Files.** A chat's files go in through the runner's file endpoint, into `/work/attachments`, at most 50 MiB each (`ATTACHMENT_MAX_FILE_BYTES`); the runner refuses any other path. Nothing of the host is mounted, and the host never writes a path the guest named. An attach copies the file to `/work/.t45/attached/<uuid>`, which the saved workspace leaves out, and T45 reads that snapshot from the running VM (the workflow hook checks that pattern) by the name the reply gives; the agent can't point T45 at another path. The hook reads and stores the snapshot as the agent's pending `application/octet-stream` file before the call transaction, which only claims the stored attachment and applies workflow changes; a refused attachment is left to the sweep. An attach whose snapshot T45 can't read, as when the VM went away first, is refused in the chat, so the agent can attach the file again.
- **Addresses.** Sandboxes take their addresses from `T45_RUNNER_SANDBOX_POOL` (10.200.0.0/16 by default). Choose a pool that does not overlap the runner's network.

## Limits

2 vCPUs, 2 GB of memory and 4 GB of disk per VM, set by the runner (`CHAT_LIMITS`). The memory is a cap, not a reservation: a VM uses about 0.5 to 0.8 GB, and CPU is the tighter limit, about one busy agent per vCPU. The runner has no cap on how many VMs run at once; a VM that can't start for lack of room is refused like any other. Running out of memory isn't named: a tool the kernel kills is just a failed call.

## Traps

- **`servers`, with `codemode: false`.** The step tools and workflow drafting sit under opencode.json's `mcp.servers`; OpenCode's older `mcp.<name>` form drops `codemode`, and the agent then calls them from its code tool, so no `step_*` parts appear in the chat.
- **Tool names come from server names.** OpenCode names an MCP tool `<server>_<tool>`, so `step_*` and `workflows_draft` match only while the servers keep the names `STEP_TOOLS_MCP` and `WORKFLOW_DRAFTING_MCP` give them.
- **The VM waits for every MCP server.** `opencode serve` answers before its MCP servers connect, and a turn started then finds no tools; so a boot waits, about a minute at most, until `/api/mcp` reports every server of the agent connected. A server that never connects fails every chat of that agent, step chats included.

## Chats

A chat names its agent (`agentId`); the agent alone sets the model and the permissions. The agents members can chat with are the active ones with `isConversational`, which the web reads with `agents.list`. T45 keeps the chat and decides when its VM runs (see [Chats](./chats.md)); the runner only runs the VM, and nothing in it outlives the VM but what T45 saves.

- **One server per chat, reached through the runner.** The chat's worker talks to the VM's OpenCode at `/chats/<chatId>/opencode/` with the runner's token as the Basic password; the runner swaps in the VM's own, made fresh at every start. The agent runs in the VM's `/work`, and a message's attachments go into `/work/attachments/` before it is delivered.
- **The VM is new at every start.** Starting a chat removes any VM left of it, disk and all, and makes a new one from the agent's current setup, so agent edits reach a chat at its next wake. `ensureChat` answers the boot's `bootId`, and a new one tells T45 to restore the chat into it.
- **The workspace goes through the runner.** `GET /chats/:chatId/workspace` packs the running VM's `/work` as the agent into a gzipped tarball, skipping files the agent can't read and leaving out what every start writes (`attachments`, `AGENTS.md`, `opencode.json`, `.opencode/skills`), the step tools' snapshots (`.t45`) and rebuildable caches anywhere (`node_modules`, `.venv`, `__pycache__`, `.cache`). `PUT` unpacks a tarball into `/work` as the agent with `--skip-old-files`, so what this start wrote wins over the saved copy (GNU tar refuses to run when `--no-overwrite-dir` is added to it).
- **T45 removes chat VMs; the runner has a backstop.** T45 removes a chat's VM when the chat sleeps or is deleted. A removal that fails on delete is tried again every 30 seconds until done; one that fails as the chat sleeps is only logged, and the runner's backstop or T45's next start removes the VM. The runner removes a chat VM nothing has been open to for 45 minutes, which outlasts a T45 restart or short outage and lets go of one T45 lost.
- **VMs stop with the runner.** They start attached, and a starting runner sweeps what an earlier process of it left: its VMs are removed, so a VM always starts with a password this runner knows. Sandboxes carry their runner's port, so runners sharing a machine, as dev checkouts do, leave each other's alone. A starting T45 removes every chat VM the runner lists that no chat wants, so a database wipe leaves none behind. A chat whose VM went away, by crashing or with the runner, is restored into a new one.
- **Sealed.** The VM's network is the agent's, and nothing in the VM can reach T45. Inbound traffic is allowed, but the only way in is the port published on the host's loopback.
- **Workflow drafts are data.** Workflow drafting is an MCP server admins add to an agent (`WORKFLOW_DRAFTING_MCP`): the image's `workflow-tools.mjs`, which only checks a draft and answers. Its `workflows_draft` call is a tool part of the chat's messages, which the web shows as a card only under that server name; the member who clicks Create makes the workflow through the ordinary API, as themselves, and the server checks the draft again. A member's chat changes nothing in T45 any other way: only a step's chat does, and only on the step named by its task trigger. No agent acts as a person.
