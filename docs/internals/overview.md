# Architecture

T45 keeps chats, workflows and agents on the server. The web client it serves controls it over authenticated RPC and never substitutes its own filesystem, provider credentials, or machine state for the server's. Agents run on the runner (`apps/runner`), one sandboxed microVM per chat, a step's agent included; the server never checks out, edits, or diffs code and runs no git. See [sandboxed chats](./sandboxed-chats.md).

## Ownership boundaries

OpenCode executes; T45 keeps what must outlive a VM. A chat's sessions, messages, inputs, questions and workspace live in T45's database and state directory, and its VM keeps nothing, so a chat survives every VM it runs in. A step's agent works in such a chat: the step keeps which chat it is, and T45 the keys of the tool calls it applied from it. The browser reads only from T45, never from a VM. See [chats](./chats.md) and [workflows](./workflows.md).

OpenCode is the only agent runtime. Chats store and send its shapes as they are, imported from `@opencode/*`, rather than translating them into a model of T45's own. See [provider constraints](./providers.md).

The web app holds its transport and the domain state it syncs (`apps/web/src/rpc` and `state`) next to its UI. See [connection runtime](./connection-runtime.md) and [remote architecture](./remote.md).

The [`RpcApi` RPC group](../../packages/contracts/src/resources/RpcApi.ts), served over `POST /api/rpc` with streams sent as ndjson, is the boundary between client and server; sign-in, attachment bytes, avatars, traces and webhooks are plain HTTP routes beside it. Streams send the state a client needs, so a client viewing one chat does not pay for every chat's history. Being signed in does not authorize every call: each is authorized on its own. See [server auth](./server-auth.md).

## Durable state and side effects

There is no event log. Each service writes its own tables, and what must change together commits in one transaction: an input with its attachments' binding, a captured page of messages with the inputs it materializes, an applied step tool call with its key, a workflow change with its posts to agents' chats, a scheduled slot's advance with its run's post, and a webhook's or Run now's post with the task's last error. Every post goes through one primitive that writes rows only, inside the caller's transaction, and wakes the chat's worker after commit. Work on a VM happens after the intent is saved: a chat's worker, the only fiber that talks to its VM, delivers what a member sent, so an answer to a send means the input is saved, not that the agent has it.

A chat's changes reach open streams through an in-process feed, published after they commit. A stream subscribes to the feed before it reads its snapshot, so a change during the read is read again after rather than lost.

Stored chat messages, sessions and questions are OpenCode's wire JSON, decoded with the pinned `@opencode` schemas, so bumping OpenCode is also a change to stored data: every stored row must still decode.

## Waiting for asynchronous work

Tests wait on an observable signal, such as a chat's change feed, a stream event or a fake's receipt, never on sleeps or polling. Production behavior follows persisted state, never test instrumentation.

See the [development runbook](../operations/development.md) for setup and checks.
